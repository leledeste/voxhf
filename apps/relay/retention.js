'use strict';

// Relay maintenance removes only files created by VoxHF backup/restore tools.
// Restrictive filename checks keep an operator's unrelated files untouched.

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_FILE = /^voxhf-[a-z0-9._-]+\.db(?:\.json)?$/i;
const PRE_RESTORE_FILE = /^voxhf\.db\.pre-restore-[a-z0-9._-]+\.db$/i;

function pruneExpiredRelayFiles(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const retentionDays = parseRetentionDays(options.retentionDays);
  const cutoff = now - retentionDays * DAY_MS;
  const deleted = [];

  pruneDirectory(options.backupDir, BACKUP_FILE, cutoff, deleted);
  pruneDirectory(options.dataDir, PRE_RESTORE_FILE, cutoff, deleted);

  return { deleted, retentionDays };
}

function pruneDirectory(directory, allowedName, cutoff, deleted) {
  const value = String(directory || '').trim();
  if (!value) return;

  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) return;

  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile() || !allowedName.test(entry.name)) continue;

    const filename = path.join(resolved, entry.name);
    if (fs.statSync(filename).mtimeMs >= cutoff) continue;

    fs.unlinkSync(filename);
    deleted.push(filename);
  }
}

function parseRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) return 30;
  return parsed;
}

module.exports = { pruneExpiredRelayFiles };
