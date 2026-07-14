'use strict';

// Keep the runtime package, browser update policy, and optional Git tag in
// agreement. A release with mismatched versions would either hide an update or
// direct users to an artifact that cannot exist.

const fs = require('fs');
const path = require('path');
const { compareVersions } = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const pkg = readJson('package.json');
const policy = readJson('webapp/release.json');
const tag = String(process.argv[2] || '').trim().replace(/^refs\/tags\//, '').replace(/^v/i, '');
const version = String(pkg.version || '');

if (!/^\d+(?:\.\d+){2}(?:-[A-Za-z0-9.:-]+)?$/.test(version)) fail(`Invalid package version: ${version}`);
if (policy.latestVersion !== version) fail(`release.json latestVersion must be ${version}`);
if (policy.recommendedLocalVersion !== version) fail(`release.json recommendedLocalVersion must be ${version}`);
if (policy.minimumLocalVersion && compareVersions(policy.minimumLocalVersion, version) > 0) {
  fail(`minimumLocalVersion ${policy.minimumLocalVersion} cannot exceed ${version}`);
}
if (tag && tag !== version) fail(`Git tag ${tag} does not match package version ${version}`);
if (!String(policy.artifactsUrl || '').includes(`/v${version}/release-artifacts.json`)) {
  fail(`release.json artifactsUrl must point to tag v${version}`);
}

console.log(`[OK] release version ${version}${tag ? ` matches tag v${tag}` : ''}`);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function fail(message) {
  console.error(`[release version] ${message}`);
  process.exit(1);
}
