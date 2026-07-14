'use strict';

// Exercise a real backup and restore against a temporary migrated relay DB.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { importRelayUserToken, openRelayDatabase } = require('../apps/relay/db');
const { pruneExpiredRelayFiles } = require('../apps/relay/retention');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-backup-test-'));
const database = path.join(temporary, 'live.db');
const backup = path.join(temporary, 'backup.db');

try {
  let db = openRelayDatabase({ filename: database });
  importRelayUserToken(db, { userId: 'before', displayName: 'Before', token: 'before-token-000000000000000000000000' });
  db.close();

  run(['backup', '--db', database, '--output', backup]);
  run(['verify', backup]);
  assert.ok(fs.existsSync(`${backup}.json`), 'backup metadata should be created');

  db = openRelayDatabase({ filename: database });
  importRelayUserToken(db, { userId: 'after', displayName: 'After', token: 'after-token-0000000000000000000000000' });
  db.close();

  run(['restore', backup, '--db', database, '--force']);
  db = openRelayDatabase({ filename: database });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE username = ?').get('before'), 'backup user should be restored');
  assert.ok(!db.prepare('SELECT 1 FROM users WHERE username = ?').get('after'), 'post-backup user should disappear');
  db.close();

  assert.ok(fs.readdirSync(temporary).some((name) => name.includes('.pre-restore-')), 'restore should retain the previous database');
  testRetention(temporary);
  console.log('[OK] relay SQLite backup and restore');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function run(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'relay-backup.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `backup command failed: ${args.join(' ')}`);
}

function testRetention(directory) {
  const backupDir = path.join(directory, 'retention-backups');
  const dataDir = path.join(directory, 'retention-data');
  fs.mkdirSync(backupDir);
  fs.mkdirSync(dataDir);

  const oldBackup = path.join(backupDir, 'voxhf-manual-old.db');
  const oldMetadata = `${oldBackup}.json`;
  const freshBackup = path.join(backupDir, 'voxhf-manual-fresh.db');
  const unrelated = path.join(backupDir, 'operator-notes.txt');
  const oldRestore = path.join(dataDir, 'voxhf.db.pre-restore-old.db');
  const now = Date.now();
  const old = new Date(now - 31 * 24 * 60 * 60 * 1000);

  for (const filename of [oldBackup, oldMetadata, freshBackup, unrelated, oldRestore]) {
    fs.writeFileSync(filename, filename);
  }
  for (const filename of [oldBackup, oldMetadata, unrelated, oldRestore]) {
    fs.utimesSync(filename, old, old);
  }

  const result = pruneExpiredRelayFiles({ backupDir, dataDir, retentionDays: 30, now });
  assert.strictEqual(result.deleted.length, 3, 'only expired VoxHF backup files should be removed');
  assert.ok(!fs.existsSync(oldBackup), 'expired backup should be removed');
  assert.ok(!fs.existsSync(oldMetadata), 'expired backup metadata should be removed');
  assert.ok(!fs.existsSync(oldRestore), 'expired pre-restore database should be removed');
  assert.ok(fs.existsSync(freshBackup), 'fresh backup should be kept');
  assert.ok(fs.existsSync(unrelated), 'unrelated files should be kept');
}
