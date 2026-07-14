'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDirectoryServer,
  deleteDirectoryServer,
  hashToken,
  listDirectoryServers,
  listPublicDirectoryServers,
  openRelayDatabase,
  rotateDirectoryServerToken,
  setDirectoryServerState,
  updateDirectoryHeartbeat,
} = require('../apps/relay/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-directory-'));
const db = openRelayDatabase({ filename: path.join(tempDir, 'voxhf.db') });

try {
  const officialToken = crypto.randomBytes(32).toString('hex');
  const independentToken = crypto.randomBytes(32).toString('hex');
  createDirectoryServer(db, server('voxhf', officialToken, true));
  createDirectoryServer(db, server('club', independentToken, false));

  assert.deepStrictEqual(listPublicDirectoryServers(db).map((row) => row.slug), ['voxhf', 'club']);
  assert.strictEqual(updateDirectoryHeartbeat(db, {
    tokenHash: hashToken(officialToken),
    version: '0.1.0',
    registrationOpen: true,
  }).count, 1);
  assert.strictEqual(listDirectoryServers(db)[0].registrationOpen, true);

  assert.strictEqual(setDirectoryServerState(db, 'club', { maintenance: true }).count, 1);
  assert.strictEqual(setDirectoryServerState(db, 'club', { enabled: false }).count, 1);
  assert.deepStrictEqual(listPublicDirectoryServers(db).map((row) => row.slug), ['voxhf']);

  const replacement = crypto.randomBytes(32).toString('hex');
  assert.strictEqual(rotateDirectoryServerToken(db, 'voxhf', hashToken(replacement)).count, 1);
  assert.strictEqual(updateDirectoryHeartbeat(db, {
    tokenHash: hashToken(officialToken),
    version: '0.1.0',
    registrationOpen: false,
  }).count, 0);
  assert.strictEqual(deleteDirectoryServer(db, 'club').count, 1);
  console.log('[OK] public directory registry');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function server(slug, token, official) {
  return {
    slug,
    name: official ? 'VoxHF Community' : 'Club Relay',
    operator: official ? 'VoxHF project' : 'Flight Club',
    region: 'Europe',
    access: 'invite',
    appUrl: official ? 'https://app.voxhf.com/' : 'https://app.club.example/',
    relayUrl: official ? 'https://relay.voxhf.com/' : 'https://relay.club.example/',
    description: 'Test relay',
    privacyUrl: 'https://example.com/privacy',
    sourceUrl: 'https://github.com/leledeste/voxhf',
    tokenHash: hashToken(token),
    official,
  };
}
