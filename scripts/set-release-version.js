'use strict';

// Update every version-controlled release field in one operation. The minimum
// compatible version changes only with --minimum because most releases should
// remain compatible with the preceding local agent.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const version = String(process.argv[2] || '').trim().replace(/^v/i, '');
const setMinimum = process.argv.includes('--minimum');
if (!/^\d+(?:\.\d+){2}(?:-[A-Za-z0-9.:-]+)?$/.test(version)) {
  console.error('Usage: npm run release:version -- 0.1.1 [--minimum]');
  process.exit(1);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const policy = readJson('webapp/release.json');

pkg.version = version;
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
policy.latestVersion = version;
policy.recommendedLocalVersion = version;
if (setMinimum) policy.minimumLocalVersion = version;
policy.artifactsUrl = `https://github.com/leledeste/voxhf/releases/download/v${version}/release-artifacts.json`;
const releasePage = version.includes('-')
  ? `https://github.com/leledeste/voxhf/releases/tag/v${version}`
  : 'https://github.com/leledeste/voxhf/releases/latest';
policy.downloadUrl = releasePage;
policy.notesUrl = releasePage;

writeJson('package.json', pkg);
writeJson('package-lock.json', lock);
writeJson('webapp/release.json', policy);
console.log(`[OK] release files updated to ${version}${setMinimum ? ' (new minimum)' : ''}`);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function writeJson(relative, value) {
  fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
}
