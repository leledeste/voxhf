'use strict';

// Manage the opt-in public server directory stored in the registry SQLite DB.
// Public identity is created here, never accepted from heartbeat requests.

const crypto = require('crypto');
const path = require('path');
const {
  createDirectoryServer,
  defaultDatabasePath,
  deleteDirectoryServer,
  hashToken,
  listDirectoryServers,
  openRelayDatabase,
  rotateDirectoryServerToken,
  setDirectoryServerState,
} = require('../apps/relay/db');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ACCESS_VALUES = new Set(['open', 'invite', 'closed']);

main(process.argv.slice(2));

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command) return printHelp();

  const dbFile = path.resolve(parsed.options.db || defaultDatabasePath());
  const db = openRelayDatabase({ filename: dbFile });
  try {
    if (parsed.command === 'list') return printServers(dbFile, db);

    const slug = requireSlug(parsed.slug);
    if (parsed.command === 'add') {
      const token = parsed.options.token || generateToken();
      requireToken(token);
      createDirectoryServer(db, {
        slug,
        name: requireText(parsed.options.name, 'name', 80),
        operator: requireText(parsed.options.operator, 'operator', 80),
        region: optionalText(parsed.options.region, 48),
        access: requireAccess(parsed.options.access || 'invite'),
        appUrl: requireHttpsUrl(parsed.options.app, 'app'),
        relayUrl: optionalHttpsUrl(parsed.options.relay, 'relay'),
        description: optionalText(parsed.options.description, 240),
        privacyUrl: optionalHttpsUrl(parsed.options.privacy, 'privacy'),
        sourceUrl: optionalHttpsUrl(parsed.options.source, 'source'),
        tokenHash: hashToken(token),
        official: parsed.options.official === true,
      });
      printToken(dbFile, slug, token, 'created');
      return;
    }

    if (parsed.command === 'rotate') {
      const token = parsed.options.token || generateToken();
      requireToken(token);
      const result = rotateDirectoryServerToken(db, slug, hashToken(token));
      requireChanged(result, slug);
      printToken(dbFile, slug, token, 'rotated');
      return;
    }

    const actions = {
      enable: { enabled: true },
      disable: { enabled: false },
      'maintenance-on': { maintenance: true },
      'maintenance-off': { maintenance: false },
    };
    if (actions[parsed.command]) {
      const result = setDirectoryServerState(db, slug, actions[parsed.command]);
      requireChanged(result, slug);
      console.log(`[directory] ${slug}: ${parsed.command}`);
      return;
    }

    if (parsed.command === 'delete') {
      const result = deleteDirectoryServer(db, slug);
      requireChanged(result, slug);
      console.log(`[directory] Deleted ${slug}. Its heartbeat token is no longer valid.`);
      return;
    }

    fail(`Unknown command: ${parsed.command}`);
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const result = { command: '', slug: '', options: {}, help: false };
  const values = new Set(['db', 'name', 'operator', 'region', 'access', 'app', 'relay', 'description', 'privacy', 'source', 'token']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '-h' || value === '--help') {
      result.help = true;
    } else if (value === '--official') {
      result.options.official = true;
    } else if (value.startsWith('--')) {
      const key = value.slice(2);
      if (!values.has(key)) fail(`Unknown option: ${value}`);
      result.options[key] = argv[++index] || '';
    } else if (!result.command) {
      result.command = value;
    } else if (!result.slug) {
      result.slug = value;
    } else {
      fail(`Unexpected argument: ${value}`);
    }
  }
  return result;
}

function printServers(dbFile, db) {
  console.log(`[directory] Database: ${dbFile}`);
  const rows = listDirectoryServers(db);
  if (!rows.length) return console.log('[directory] No servers registered.');
  for (const row of rows) {
    const flags = [row.official ? 'official' : 'independent', row.enabled ? 'enabled' : 'disabled'];
    if (row.maintenance) flags.push('maintenance');
    console.log(`${row.slug}\t${flags.join(',')}\t${row.access}\t${row.name}\tlast=${row.lastSeenAt || 'never'}`);
  }
}

function printToken(dbFile, slug, token, action) {
  console.log(`[directory] Server ${action}: ${slug}`);
  console.log(`[directory] Database: ${dbFile}`);
  console.log('');
  console.log('Heartbeat token shown once:');
  console.log(token);
  console.log('');
  console.log('Add these values to the listed server private environment:');
  console.log('VOXHF_DIRECTORY_PUBLISH=true');
  console.log('VOXHF_DIRECTORY_HEARTBEAT_URL=https://voxhf.com/directory/api/heartbeat');
  console.log(`VOXHF_DIRECTORY_HEARTBEAT_TOKEN=${token}`);
}

function requireChanged(result, slug) {
  if (!result.count) fail(`Directory server not found: ${slug}`);
}

function requireSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) fail('Slug must be 1-48 lowercase letters, numbers, or hyphens.');
  return slug;
}

function requireText(value, field, maxLength) {
  const text = optionalText(value, maxLength);
  if (!text) fail(`--${field} is required.`);
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) fail(`Value is longer than ${maxLength} characters.`);
  return text;
}

function requireAccess(value) {
  const access = String(value || '').trim().toLowerCase();
  if (!ACCESS_VALUES.has(access)) fail('--access must be open, invite, or closed.');
  return access;
}

function requireHttpsUrl(value, field) {
  const url = optionalHttpsUrl(value, field);
  if (!url) fail(`--${field} is required and must use HTTPS.`);
  return url;
}

function optionalHttpsUrl(value, field) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.toString();
  } catch (_) {}
  fail(`--${field} must be an HTTPS URL without embedded credentials.`);
}

function requireToken(value) {
  if (!/^[A-Fa-f0-9]{64,128}$/.test(String(value || ''))) fail('Heartbeat token must be 64-128 hexadecimal characters.');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function printHelp() {
  console.log(`VoxHF public directory registry helper

Usage:
  npm run directory:server -- list [--db path/to/voxhf.db]
  npm run directory:server -- add <slug> --name "Name" --operator "Operator" --app https://app.example [options]
  npm run directory:server -- rotate <slug> [--token hex] [--db path]
  npm run directory:server -- enable|disable <slug> [--db path]
  npm run directory:server -- maintenance-on|maintenance-off <slug> [--db path]
  npm run directory:server -- delete <slug> [--db path]

Add options:
  --region text                 Directory region label
  --access open|invite|closed  Default: invite
  --relay https://...          Public relay URL
  --description text           Short public description
  --privacy https://...        Operator privacy notice
  --source https://...         Declared source repository
  --official                   Reserved for a VoxHF-operated server
  --token hex                  Supply a token instead of generating one

Example:
  npm run directory:server -- add voxhf-community --name "VoxHF Community" --operator "VoxHF project" --region Europe --access invite --app https://app.voxhf.com --relay https://relay.voxhf.com --privacy https://voxhf.com/privacy.html --source https://github.com/leledeste/voxhf --official
`);
}

function fail(message) {
  console.error(`[directory] ${message}`);
  process.exit(1);
}
