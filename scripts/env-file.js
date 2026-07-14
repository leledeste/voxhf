'use strict';

const fs = require('fs');

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    env[key] = unquote(trimmed.slice(separator + 1).trim());
  }
  return env;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnv(fs.readFileSync(filePath, 'utf8'));
}

function applyEnvFile(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  for (const [key, value] of Object.entries(readEnvFile(filePath))) {
    if (target[key] === undefined) target[key] = value;
  }
  return true;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

module.exports = {
  applyEnvFile,
  parseEnv,
  readEnvFile,
};