'use strict';

// Small helper for the preview relay user registry.
//
// The current Remote Preview does not have a database or admin dashboard.
// Independent users are configured through VOXHF_RELAY_USERS in a .env file.
// This script edits that one setting safely and prints newly generated tokens
// only when they are created or rotated.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('./env-file');

const root = path.resolve(__dirname, '..');
const DEFAULT_ENV_CANDIDATES = [
  path.join(root, 'infra', 'docker', '.env'),
  path.join(root, 'apps', 'relay', '.env'),
];
const USERS_KEY = 'VOXHF_RELAY_USERS';
const DEFAULT_TOKEN_KEY = 'VOXHF_RELAY_TOKEN';
const USER_ID_RE = /^[A-Za-z0-9._-]{2,48}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{16,256}$/;

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command) return printHelp();

  const envFile = resolveEnvFile(parsed.options.env);
  const text = fs.readFileSync(envFile, 'utf8');
  const env = parseEnv(text);
  const users = parseUsers(env[USERS_KEY] || '');

  if (parsed.command === 'list') {
    printUsers(envFile, env, users);
    return;
  }

  if (parsed.command === 'print') {
    const userId = requireUserId(parsed.userId);
    const token = parsed.options.token || generateToken();
    requireToken(token);
    console.log(`${userId}=${token}`);
    return;
  }

  const userId = requireUserId(parsed.userId);

  if (parsed.command === 'add') {
    if (users.has(userId)) fail(`User "${userId}" already exists. Use "rotate" to replace its token.`);
    const token = parsed.options.token || generateToken();
    requireToken(token);
    users.set(userId, token);
    writeUsers(envFile, text, users);
    printChanged('added', envFile, userId, token);
    return;
  }

  if (parsed.command === 'rotate') {
    if (!users.has(userId)) fail(`User "${userId}" does not exist. Use "add" first.`);
    const token = parsed.options.token || generateToken();
    requireToken(token);
    users.set(userId, token);
    writeUsers(envFile, text, users);
    printChanged('rotated', envFile, userId, token);
    return;
  }

  if (parsed.command === 'remove') {
    if (!users.delete(userId)) fail(`User "${userId}" does not exist.`);
    writeUsers(envFile, text, users);
    console.log(`[relay-user] Removed ${userId} from ${displayPath(envFile)}.`);
    console.log('[relay-user] Restart the relay for the change to take effect.');
    return;
  }

  fail(`Unknown command: ${parsed.command}`);
}

function parseArgs(argv) {
  const args = [...argv];
  const result = { command: '', userId: '', options: {}, help: false };

  while (args.length) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '--env') {
      result.options.env = args.shift() || '';
      continue;
    }
    if (arg === '--token') {
      result.options.token = args.shift() || '';
      continue;
    }
    if (!result.command) {
      result.command = arg;
      continue;
    }
    if (!result.userId) {
      result.userId = arg;
      continue;
    }
    fail(`Unexpected argument: ${arg}`);
  }

  return result;
}

function resolveEnvFile(option) {
  const candidate = option
    ? path.resolve(process.cwd(), option)
    : DEFAULT_ENV_CANDIDATES.find((file) => fs.existsSync(file));

  if (!candidate) {
    fail('No .env file found. Copy apps/relay/.env.example or infra/docker/.env.example first, or pass --env path/to/.env.');
  }
  if (!fs.existsSync(candidate)) fail(`Env file does not exist: ${candidate}`);
  return candidate;
}

function parseUsers(raw) {
  const users = new Map();
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0 || index >= trimmed.length - 1) fail(`Invalid ${USERS_KEY} entry: ${trimmed}`);
    const userId = trimmed.slice(0, index).trim();
    const token = trimmed.slice(index + 1).trim();
    requireUserId(userId);
    requireToken(token);
    if (users.has(userId)) fail(`Duplicate user id in ${USERS_KEY}: ${userId}`);
    users.set(userId, token);
  }
  return users;
}

function writeUsers(envFile, originalText, users) {
  const value = Array.from(users.entries())
    .map(([userId, token]) => `${userId}=${token}`)
    .join(',');
  fs.writeFileSync(envFile, setEnvValue(originalText, USERS_KEY, value), 'utf8');
}

function setEnvValue(text, key, value) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let updated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    lines[index] = `${key}=${value}`;
    updated = true;
    break;
  }

  if (!updated) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(`${key}=${value}`);
  }

  return lines.join(newline).replace(/\s*$/, newline);
}

function printUsers(envFile, env, users) {
  console.log(`[relay-user] Env file: ${displayPath(envFile)}`);
  if (env[DEFAULT_TOKEN_KEY]) console.log('[relay-user] Default shared token: configured');
  if (!users.size) {
    console.log(`[relay-user] ${USERS_KEY}: no users configured`);
    return;
  }
  for (const [userId, token] of users.entries()) {
    console.log(`${userId}=${maskToken(token)}`);
  }
}

function printChanged(action, envFile, userId, token) {
  console.log(`[relay-user] User ${action}: ${userId}`);
  console.log(`[relay-user] Env file updated: ${displayPath(envFile)}`);
  console.log('');
  console.log('Token shown once:');
  console.log(token);
  console.log('');
  console.log('Use this token in the local proxy config and in the hosted webapp Remote settings.');
  console.log('Restart the relay for the change to take effect.');
}

function requireUserId(userId) {
  const value = String(userId || '').trim();
  if (!USER_ID_RE.test(value)) {
    fail('User id must be 2-48 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  return value;
}

function requireToken(token) {
  const value = String(token || '').trim();
  if (!TOKEN_RE.test(value) || value.includes(',')) {
    fail('Token must be 16-256 visible token characters and must not contain commas.');
  }
  return value;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 14) return `${token.slice(0, 3)}...`;
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function displayPath(file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative;
}

function printHelp() {
  console.log(`VoxHF relay user helper

Usage:
  npm run relay:user -- list [--env path/to/.env]
  npm run relay:user -- add <user_id> [--env path/to/.env]
  npm run relay:user -- rotate <user_id> [--env path/to/.env]
  npm run relay:user -- remove <user_id> [--env path/to/.env]
  npm run relay:user -- print <user_id>

Default .env lookup:
  1. infra/docker/.env
  2. apps/relay/.env

Examples:
  npm run relay:user -- add daniele --env infra/docker/.env
  npm run relay:user -- rotate daniele --env infra/docker/.env
  npm run relay:user -- list --env infra/docker/.env
`);
}

function fail(message) {
  console.error(`[relay-user] ${message}`);
  process.exit(1);
}

main(process.argv.slice(2));
