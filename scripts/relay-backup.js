'use strict';

// Create, verify, and restore consistent VoxHF SQLite backups.
//
// Backup uses SQLite's online backup API, so WAL state is copied correctly.
// Restore requires --force and must be run while the relay is stopped. The
// previous live database is preserved as a timestamped pre-restore backup.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const packageJson = require('../package.json');
const { defaultDatabasePath } = require('../apps/relay/db');

main(process.argv.slice(2)).catch((err) => {
  console.error(`[backup] ${err.message}`);
  process.exitCode = 1;
});

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command) return printHelp();

  if (args.command === 'backup') {
    await createBackup(args);
    return;
  }
  if (args.command === 'verify') {
    verifyBackup(requireInput(args));
    return;
  }
  if (args.command === 'restore') {
    restoreBackup(requireInput(args), args);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

async function createBackup(args) {
  const dbFile = path.resolve(args.db || defaultDatabasePath());
  if (!fs.existsSync(dbFile)) throw new Error(`Database does not exist: ${dbFile}`);
  const output = path.resolve(args.output || defaultBackupPath(dbFile));
  if (path.resolve(dbFile) === output) throw new Error('Backup output must differ from the live database.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw new Error(`Backup already exists: ${output}`);

  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    await db.backup(output);
  } catch (err) {
    fs.rmSync(output, { force: true });
    throw err;
  } finally {
    db.close();
  }

  const summary = inspectDatabase(output);
  const metadata = {
    format: 1,
    product: 'VoxHF',
    appVersion: packageJson.version,
    createdAt: new Date().toISOString(),
    file: path.basename(output),
    bytes: fs.statSync(output).size,
    sha256: sha256File(output),
    schemaVersion: summary.schemaVersion,
  };
  fs.writeFileSync(`${output}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  console.log(`[backup] Database: ${output}`);
  console.log(`[backup] Metadata: ${output}.json`);
  console.log(`[backup] SHA-256: ${metadata.sha256}`);
}

function verifyBackup(input) {
  const backup = path.resolve(input);
  if (!fs.existsSync(backup)) throw new Error(`Backup does not exist: ${backup}`);
  const summary = inspectDatabase(backup);
  const metadataFile = `${backup}.json`;
  if (fs.existsSync(metadataFile)) {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const actualHash = sha256File(backup);
    if (metadata.sha256 !== actualHash) throw new Error('Backup checksum does not match its metadata.');
    if (metadata.bytes !== fs.statSync(backup).size) throw new Error('Backup size does not match its metadata.');
  }
  console.log(`[backup] Valid SQLite backup: ${backup}`);
  console.log(`[backup] Schema version: ${summary.schemaVersion}`);
}

function restoreBackup(input, args) {
  if (!args.force) throw new Error('Restore is destructive. Stop the relay and repeat with --force.');
  const source = path.resolve(input);
  const dbFile = path.resolve(args.db || defaultDatabasePath());
  if (source === dbFile) throw new Error('Backup and live database paths must differ.');
  verifyBackupSilently(source);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const stamp = timestamp();
  const temporary = `${dbFile}.restore-${stamp}.tmp`;
  const retired = `${dbFile}.pre-restore-${stamp}.db`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);

  let movedCurrent = false;
  try {
    if (fs.existsSync(dbFile)) {
      checkpointDatabase(dbFile);
      fs.renameSync(dbFile, retired);
      movedCurrent = true;
    }
    removeSqliteSidecars(dbFile);
    fs.renameSync(temporary, dbFile);
    inspectDatabase(dbFile);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    if (movedCurrent && !fs.existsSync(dbFile) && fs.existsSync(retired)) fs.renameSync(retired, dbFile);
    throw err;
  }

  console.log(`[backup] Restored: ${dbFile}`);
  if (movedCurrent) console.log(`[backup] Previous database kept as: ${retired}`);
}

function inspectDatabase(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const schemaVersion = hasMigrations
      ? Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version)
      : 0;
    return { schemaVersion };
  } finally {
    db.close();
  }
}

function checkpointDatabase(file) {
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    if (result[0]?.busy) throw new Error('Database is busy. Stop the relay before restoring.');
  } finally {
    db.close();
  }
}

function verifyBackupSilently(file) {
  inspectDatabase(file);
  const metadataFile = `${file}.json`;
  if (!fs.existsSync(metadataFile)) return;
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.sha256 !== sha256File(file)) throw new Error('Backup checksum does not match its metadata.');
}

function removeSqliteSidecars(file) {
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

function parseArgs(argv) {
  const result = { command: '', input: '', output: '', db: '', force: false, help: false };
  const args = [...argv];
  while (args.length) {
    const value = args.shift();
    if (value === '--help' || value === '-h') result.help = true;
    else if (value === '--force') result.force = true;
    else if (value === '--db') result.db = args.shift() || '';
    else if (value === '--output') result.output = args.shift() || '';
    else if (!result.command) result.command = value;
    else if (!result.input) result.input = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return result;
}

function requireInput(args) {
  if (!args.input) throw new Error(`${args.command} requires a backup file.`);
  return args.input;
}

function defaultBackupPath(dbFile) {
  const directory = process.env.VOXHF_BACKUP_DIR
    ? path.resolve(process.env.VOXHF_BACKUP_DIR)
    : path.join(path.dirname(dbFile), 'backups');
  return path.join(directory, `voxhf-${timestamp()}.db`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function printHelp() {
  console.log(`VoxHF SQLite backup helper

Usage:
  npm run relay:backup -- backup [--db live.db] [--output backup.db]
  npm run relay:backup -- verify backup.db
  npm run relay:backup -- restore backup.db [--db live.db] --force

Stop the relay before restore. Backup can run while the relay is online.`);
}

module.exports = { createBackup, inspectDatabase, restoreBackup, verifyBackup };
