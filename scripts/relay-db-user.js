'use strict';

// Manage relay users and agent tokens directly in the SQLite database.
//
// This is the no-dashboard path for self-hosted relays that choose
// VOXHF_RELAY_AUTH_MODE=sqlite-fallback or sqlite. Tokens are printed only
// when created or rotated; afterwards only their short prefixes are visible.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  defaultDatabasePath,
  getRelayUser,
  importRelayUserToken,
  listRelayUserSummaries,
  openRelayDatabase,
  revokeRelayUserTokens,
  setRelayUserDisabled,
  deleteRelayUser,
} = require('../apps/relay/db');

const root = path.resolve(__dirname, '..');
const DEFAULT_TOKEN_NAME = 'Relay preview token';
const USER_ID_RE = /^[A-Za-z0-9._-]{2,48}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{16,256}$/;

main(process.argv.slice(2)).catch((err) => {
  fail(err.message || String(err));
});

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command) return printHelp();

  if (parsed.command === 'print') {
    const userId = requireUserId(parsed.userId);
    const token = parsed.options.token || generateToken();
    requireToken(token);
    console.log(`${userId}=${token}`);
    return;
  }

  const dbFile = path.resolve(parsed.options.db || defaultDatabasePath());
  const db = openRelayDatabase({ filename: dbFile });

  try {
    if (parsed.command === 'list') {
      printUsers(dbFile, db);
      return;
    }

    if (parsed.command === 'backup') {
      await backupDatabase(db, dbFile, parsed.userId || parsed.options.output);
      return;
    }

    const userId = requireUserId(parsed.userId);

    if (parsed.command === 'add') {
      if (getRelayUser(db, userId)) fail(`User "${userId}" already exists. Use "rotate" to replace its token.`);
      const token = parsed.options.token || generateToken();
      requireToken(token);
      const result = importRelayUserToken(db, {
        userId,
        displayName: parsed.options.name || userId,
        token,
        tokenName: parsed.options.tokenName || DEFAULT_TOKEN_NAME,
      });
      printTokenChange(dbFile, result.action, userId, token);
      return;
    }

    if (parsed.command === 'rotate') {
      const existing = getRelayUser(db, userId);
      if (!existing) fail(`User "${userId}" does not exist. Use "add" first.`);
      const token = parsed.options.token || generateToken();
      requireToken(token);
      const result = importRelayUserToken(db, {
        userId,
        displayName: parsed.options.name || existing.displayName || userId,
        token,
        tokenName: parsed.options.tokenName || DEFAULT_TOKEN_NAME,
      });
      printTokenChange(dbFile, result.action, userId, token);
      return;
    }

    if (parsed.command === 'revoke') {
      const result = revokeRelayUserTokens(db, {
        userId,
        tokenName: parsed.options.tokenName || DEFAULT_TOKEN_NAME,
      });
      console.log(`[relay-db-user] Revoked ${result.count} active token(s) for ${result.userId}.`);
      console.log('[relay-db-user] Restart the relay for already-running processes to reload token state.');
      return;
    }

    if (parsed.command === 'disable') {
      const result = setRelayUserDisabled(db, userId, true);
      console.log(`[relay-db-user] User ${result.action}: ${result.userId}`);
      console.log('[relay-db-user] Restart the relay for already-running processes to reload token state.');
      return;
    }

    if (parsed.command === 'enable') {
      const result = setRelayUserDisabled(db, userId, false);
      console.log(`[relay-db-user] User ${result.action}: ${result.userId}`);
      console.log('[relay-db-user] Restart the relay for already-running processes to reload token state.');
      return;
    }

    if (parsed.command === 'delete') {
      const result = deleteRelayUser(db, userId);
      console.log(`[relay-db-user] User ${result.action}: ${result.userId}`);
      console.log(`[relay-db-user] Deleted row count: ${result.count}`);
      console.log('[relay-db-user] Restart the relay for already-running processes to reload token state.');
      return;
    }

    fail(`Unknown command: ${parsed.command}`);
  } finally {
    db.close();
  }
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
    if (arg === '--db') {
      result.options.db = args.shift() || '';
      continue;
    }
    if (arg === '--name') {
      result.options.name = args.shift() || '';
      continue;
    }
    if (arg === '--token') {
      result.options.token = args.shift() || '';
      continue;
    }
    if (arg === '--token-name') {
      result.options.tokenName = args.shift() || '';
      continue;
    }
    if (arg === '--output') {
      result.options.output = args.shift() || '';
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

function printUsers(dbFile, db) {
  console.log(`[relay-db-user] Database: ${displayPath(dbFile)}`);
  const rows = listRelayUserSummaries(db);
  if (!rows.length) {
    console.log('[relay-db-user] No relay users found.');
    return;
  }

  for (const row of rows) {
    const state = row.disabledAt ? 'disabled' : 'active';
    const prefixes = row.activeTokenPrefixes || '-';
    console.log(`${row.userId}\t${state}\ttokens=${row.activeTokenCount || 0}/${row.tokenCount || 0}\tprefixes=${prefixes}\tname=${row.displayName}`);
  }
}

async function backupDatabase(db, dbFile, output) {
  const target = output ? path.resolve(process.cwd(), output) : defaultBackupPath(dbFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await db.backup(target);
  console.log(`[relay-db-user] Backup written: ${displayPath(target)}`);
}

function defaultBackupPath(dbFile) {
  const parsed = path.parse(dbFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext || '.db'}`);
}

function printTokenChange(dbFile, action, userId, token) {
  console.log(`[relay-db-user] User ${action}: ${userId}`);
  console.log(`[relay-db-user] Database: ${displayPath(dbFile)}`);
  console.log('');
  console.log('Token shown once:');
  console.log(token);
  console.log('');
  console.log('Use this token in the local proxy config and in the hosted webapp Remote settings.');
  console.log('Restart the relay for already-running processes to reload token state.');
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

function displayPath(file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative;
}

function printHelp() {
  console.log(`VoxHF SQLite relay user helper

Usage:
  npm run relay:db:user -- list [--db path/to/voxhf.db]
  npm run relay:db:user -- add <user_id> [--name "Display Name"] [--token token] [--db path/to/voxhf.db]
  npm run relay:db:user -- rotate <user_id> [--token token] [--db path/to/voxhf.db]
  npm run relay:db:user -- revoke <user_id> [--db path/to/voxhf.db]
  npm run relay:db:user -- disable <user_id> [--db path/to/voxhf.db]
  npm run relay:db:user -- enable <user_id> [--db path/to/voxhf.db]
  npm run relay:db:user -- delete <user_id> [--db path/to/voxhf.db]
  npm run relay:db:user -- backup [output.db] [--db path/to/voxhf.db]
  npm run relay:db:user -- print <user_id>

Examples:
  npm run relay:db:user -- add daniele --db .voxhf-relay/voxhf.db
  npm run relay:db:user -- rotate daniele --db .voxhf-relay/voxhf.db
  npm run relay:db:user -- list --db .voxhf-relay/voxhf.db
`);
}

function fail(message) {
  console.error(`[relay-db-user] ${message}`);
  process.exit(1);
}
