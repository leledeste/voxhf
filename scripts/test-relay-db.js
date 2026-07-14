'use strict';

// Minimal SQLite migration smoke test.
//
// It uses a temporary database so `npm run verify` can validate the database
// foundation without touching a real relay installation.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  hashToken,
  importRelayUserToken,
  insertAuditEvent,
  listActiveBrowserPairings,
  listAuditEvents,
  listRelayAgentSummaries,
  openRelayDatabase,
  revokeBrowserPairingById,
  upsertBrowserPairing,
  upsertRelayAgent,
} = require('../apps/relay/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-db-'));
const dbFile = path.join(tempDir, 'voxhf.db');

try {
  let db = openRelayDatabase({ filename: dbFile });
  assertDatabaseShape(db);
  assertForeignKeys(db);
  assertRelayUserImport(db);
  assertPairingPersistence(db);
  assertAuditEvents(db);
  db.close();

  db = openRelayDatabase({ filename: dbFile });
  const migrationCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
  assert.ok(migrationCount >= 2, 'all migrations should be recorded');
  db.close();

  console.log('[OK] relay database migrations');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertAuditEvents(db) {
  insertAuditEvent(db, {
    eventType: 'admin.user_created',
    userId: 'alice',
    actorType: 'admin',
    actorId: 'admin-token',
    ipAddress: '127.0.0.1',
    metadata: { targetUserId: 'alice' },
  });

  const events = listAuditEvents(db, { limit: 10 });
  assert.ok(events.some((event) => event.eventType === 'admin.user_created'), 'audit events should be listed');
  const event = events.find((candidate) => candidate.eventType === 'admin.user_created');
  assert.strictEqual(event.userId, 'alice', 'audit event should resolve the user name');
  assert.ok(event.metadataJson.includes('targetUserId'), 'audit event should preserve structured metadata');
}

function assertPairingPersistence(db) {
  upsertRelayAgent(db, {
    userId: 'alice',
    deviceId: 'device-alice',
    deviceName: 'Alice PC',
  });
  upsertBrowserPairing(db, {
    userId: 'alice',
    deviceId: 'device-alice',
    deviceName: 'Alice PC',
    browserId: 'browser-alice',
  });

  const devices = listRelayAgentSummaries(db).filter((device) => device.userId === 'alice');
  assert.strictEqual(devices.length, 1, 'relay agents should be listed for admin views');
  assert.strictEqual(devices[0].activePairingCount, 1, 'agent should count active browser pairings');

  const pairings = listActiveBrowserPairings(db).filter((pairing) => pairing.userId === 'alice');
  assert.strictEqual(pairings.length, 1, 'browser pairing should be persisted');
  assert.strictEqual(pairings[0].deviceId, 'device-alice', 'pairing should point at the agent device');

  const revoked = revokeBrowserPairingById(db, pairings[0].pairingId);
  assert.strictEqual(revoked.count, 1, 'pairing should be revocable by id');
  assert.strictEqual(
    listActiveBrowserPairings(db).filter((pairing) => pairing.userId === 'alice').length,
    0,
    'revoked pairings should not be listed as active'
  );
}

function assertDatabaseShape(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  );
  for (const table of [
    'schema_migrations',
    'users',
    'agent_tokens',
    'agents',
    'browser_pairings',
    'browser_sessions',
    'audit_events',
  ]) {
    assert.ok(tables.has(table), `${table} table should exist`);
  }

  assert.strictEqual(
    db.prepare('SELECT version, name FROM schema_migrations').get().version,
    1,
    'initial migration should be recorded'
  );
  assert.ok(
    db.prepare('SELECT 1 FROM pragma_table_info(\'users\') WHERE name = ?').get('password_hash'),
    'account password migration should add users.password_hash'
  );
}

function assertForeignKeys(db) {
  db.prepare(`
    INSERT INTO users (id, username, display_name)
    VALUES ('user-test', 'test_user', 'Test User')
  `).run();
  db.prepare(`
    INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash)
    VALUES ('token-test', 'user-test', 'Home PC', 'abcdef12', 'hash-test')
  `).run();
  db.prepare(`
    INSERT INTO agents (id, user_id, token_id, device_id, name)
    VALUES ('agent-test', 'user-test', 'token-test', 'device-test', 'Home PC')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash)
      VALUES ('token-bad', 'missing-user', 'Broken', 'bad', 'hash-bad')
    `).run();
  }, /FOREIGN KEY/, 'foreign keys should be enabled');
}

function assertRelayUserImport(db) {
  const created = importRelayUserToken(db, {
    userId: 'alice',
    displayName: 'Alice',
    token: 'alice-token-00000000000000000000000000000000',
  });
  assert.strictEqual(created.action, 'created', 'first import should create a token');

  const unchanged = importRelayUserToken(db, {
    userId: 'alice',
    displayName: 'Alice',
    token: 'alice-token-00000000000000000000000000000000',
  });
  assert.strictEqual(unchanged.action, 'unchanged', 'same token should not duplicate');

  const rotated = importRelayUserToken(db, {
    userId: 'alice',
    displayName: 'Alice',
    token: 'alice-token-11111111111111111111111111111111',
  });
  assert.strictEqual(rotated.action, 'rotated', 'changed token should rotate');

  const active = db.prepare(`
    SELECT token_hash AS tokenHash
    FROM agent_tokens
    JOIN users ON users.id = agent_tokens.user_id
    WHERE users.username = 'alice' AND agent_tokens.revoked_at IS NULL
  `).all();
  assert.strictEqual(active.length, 1, 'only one active token should remain after rotation');
  assert.strictEqual(
    active[0].tokenHash,
    hashToken('alice-token-11111111111111111111111111111111'),
    'active token hash should match rotated token'
  );
}
