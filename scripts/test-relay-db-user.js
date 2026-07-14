'use strict';

// End-to-end smoke test for the SQLite relay user CLI.
//
// The test drives the public script instead of calling helpers directly, so it
// catches argument parsing, output paths, token lifecycle changes, and backups.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listActiveRelayTokenUsers,
  listRelayUserSummaries,
  openRelayDatabase,
} = require('../apps/relay/db');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-db-user-'));
const dbFile = path.join(tempDir, 'voxhf.db');
const backupFile = path.join(tempDir, 'backup.db');

try {
  runCli(['add', 'alice', '--name', 'Alice Example', '--token', 'alice-token-00000000000000000000000000000000']);
  assertActiveUsers(['alice'], 'alice should be active after add');

  const duplicate = runCli(['add', 'alice', '--token', 'alice-token-duplicate-0000000000000000000000'], { expectFailure: true });
  assert.match(duplicate.stderr, /already exists/, 'duplicate add should fail clearly');

  runCli(['rotate', 'alice', '--token', 'alice-token-11111111111111111111111111111111']);
  assertActiveUsers(['alice'], 'alice should remain active after rotate');
  assertSummary('alice', { activeTokens: 1, totalTokens: 2, disabled: false });

  runCli(['disable', 'alice']);
  assertActiveUsers([], 'disabled user should not authenticate');
  assertSummary('alice', { activeTokens: 1, totalTokens: 2, disabled: true });

  runCli(['enable', 'alice']);
  assertActiveUsers(['alice'], 'enabled user should authenticate again');

  runCli(['revoke', 'alice']);
  assertActiveUsers([], 'revoked tokens should not authenticate');
  assertSummary('alice', { activeTokens: 0, totalTokens: 2, disabled: false });

  runCli(['backup', backupFile]);
  assert.ok(fs.existsSync(backupFile), 'backup file should exist');
  assert.ok(fs.statSync(backupFile).size > 0, 'backup file should not be empty');

  runCli(['add', 'bob', '--token', 'bob-token-0000000000000000000000000000000000']);
  assertSummary('bob', { activeTokens: 1, totalTokens: 1, disabled: false });
  runCli(['delete', 'bob']);
  assertNoSummary('bob');

  const list = runCli(['list']);
  assert.match(list.stdout, /alice\s+active\s+tokens=0\/2/, 'list should show token counts');
  assert.doesNotMatch(list.stdout, /bob\s+/, 'deleted user should not be listed');

  console.log('[OK] relay database user CLI');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'relay-db-user.js'),
    ...args,
    '--db',
    dbFile,
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (options.expectFailure) {
    assert.notStrictEqual(result.status, 0, `command should fail: ${args.join(' ')}`);
    return result;
  }

  assert.strictEqual(
    result.status,
    0,
    `command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

function assertActiveUsers(expectedUserIds, message) {
  const db = openRelayDatabase({ filename: dbFile });
  try {
    const actual = listActiveRelayTokenUsers(db).map((row) => row.userId).sort();
    assert.deepStrictEqual(actual, expectedUserIds.sort(), message);
  } finally {
    db.close();
  }
}

function assertSummary(userId, expected) {
  const db = openRelayDatabase({ filename: dbFile });
  try {
    const row = listRelayUserSummaries(db).find((item) => item.userId === userId);
    assert.ok(row, `${userId} summary should exist`);
    assert.strictEqual(row.activeTokenCount, expected.activeTokens, `${userId} active token count`);
    assert.strictEqual(row.tokenCount, expected.totalTokens, `${userId} total token count`);
    assert.strictEqual(Boolean(row.disabledAt), expected.disabled, `${userId} disabled state`);
  } finally {
    db.close();
  }
}

function assertNoSummary(userId) {
  const db = openRelayDatabase({ filename: dbFile });
  try {
    const row = listRelayUserSummaries(db).find((item) => item.userId === userId);
    assert.strictEqual(row, undefined, `${userId} summary should not exist`);
  } finally {
    db.close();
  }
}
