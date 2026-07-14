'use strict';

// Import preview relay users from a .env file into the SQLite relay database.
//
// The relay still authenticates from .env by default. After importing, set
// VOXHF_RELAY_AUTH_MODE=sqlite-fallback to test SQLite tokens with .env
// fallback, or "sqlite" after confirming the DB tokens work.

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('./env-file');
const {
  defaultDatabasePath,
  importRelayUserToken,
  listImportedRelayUsers,
  openRelayDatabase,
} = require('../apps/relay/db');

const root = path.resolve(__dirname, '..');
const DEFAULT_ENV_CANDIDATES = [
  path.join(root, 'infra', 'docker', '.env'),
  path.join(root, 'apps', 'relay', '.env'),
];
const USERS_KEY = 'VOXHF_RELAY_USERS';
const DEFAULT_TOKEN_KEY = 'VOXHF_RELAY_TOKEN';
const USER_ID_RE = /^[A-Za-z0-9._-]{2,48}$/;

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) return printHelp();

  const envFile = resolveEnvFile(parsed.env);
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const dbFile = path.resolve(parsed.db || defaultDatabasePath(env));
  const users = readRelayUsers(env);

  if (!users.length) {
    console.log(`[relay-db] No relay users found in ${displayPath(envFile)}.`);
    return;
  }

  const db = openRelayDatabase({ filename: dbFile });
  try {
    const results = users.map((user) => importRelayUserToken(db, user));
    console.log(`[relay-db] Env file: ${displayPath(envFile)}`);
    console.log(`[relay-db] Database: ${displayPath(dbFile)}`);
    for (const result of results) {
      console.log(`[relay-db] ${result.action}: ${result.userId} (${result.tokenPrefix}...)`);
    }

    if (parsed.list) printImportedUsers(db);
    console.log('[relay-db] Import complete. Set VOXHF_RELAY_AUTH_MODE=sqlite-fallback to test DB auth with .env fallback.');
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const result = { env: '', db: '', list: false, help: false };
  const args = [...argv];

  while (args.length) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '--env') {
      result.env = args.shift() || '';
      continue;
    }
    if (arg === '--db') {
      result.db = args.shift() || '';
      continue;
    }
    if (arg === '--list') {
      result.list = true;
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

function readRelayUsers(env) {
  const users = parseUsers(env[USERS_KEY] || '');
  const defaultToken = String(env[DEFAULT_TOKEN_KEY] || '').trim();
  if (defaultToken) {
    if (users.some((user) => user.userId === 'default')) {
      fail(`${USERS_KEY} cannot include reserved user "default" when ${DEFAULT_TOKEN_KEY} is set.`);
    }
    users.push({
      userId: 'default',
      displayName: 'Default',
      token: defaultToken,
      tokenName: 'Default relay token',
    });
  }
  return users;
}

function parseUsers(raw) {
  const users = [];
  const seen = new Set();
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0 || index >= trimmed.length - 1) fail(`Invalid ${USERS_KEY} entry: ${trimmed}`);

    const userId = trimmed.slice(0, index).trim();
    const token = trimmed.slice(index + 1).trim();
    requireUserId(userId);
    if (!token) fail(`Missing token for relay user: ${userId}`);
    if (seen.has(userId)) fail(`Duplicate relay user id: ${userId}`);
    seen.add(userId);

    users.push({
      userId,
      displayName: userId,
      token,
      tokenName: 'Relay preview token',
    });
  }
  return users;
}

function printImportedUsers(db) {
  const rows = listImportedRelayUsers(db);
  for (const row of rows) {
    const state = row.revokedAt ? `revoked ${row.revokedAt}` : 'active';
    console.log(`[relay-db] user=${row.username} token=${row.tokenName || '-'} prefix=${row.tokenPrefix || '-'} ${state}`);
  }
}

function requireUserId(userId) {
  const value = String(userId || '').trim();
  if (!USER_ID_RE.test(value)) {
    fail('User id must be 2-48 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  return value;
}

function displayPath(file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative;
}

function printHelp() {
  console.log(`VoxHF relay .env to SQLite importer

Usage:
  npm run relay:db:import-users -- [--env path/to/.env] [--db path/to/voxhf.db] [--list]

Examples:
  npm run relay:db:import-users -- --env apps/relay/.env --db .voxhf-relay/voxhf.db --list
  npm run relay:db:import-users -- --env infra/docker/.env --db ./voxhf.db
`);
}

function fail(message) {
  console.error(`[relay-db] ${message}`);
  process.exit(1);
}

main(process.argv.slice(2));
