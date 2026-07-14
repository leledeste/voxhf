'use strict';

// Safely stage a VoxHF Local update beside the current installation.
//
// The updater trusts an HTTPS release policy, verifies the selected ZIP against
// release-artifacts.json, and never overwrites a working installation. The user
// starts the staged folder after stopping the current proxy; the old folder is
// therefore an immediate rollback path.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compareVersions } = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const currentVersion = require('../package.json').version;
const DEFAULT_POLICY_URL = 'https://voxhf.com/release.json';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[update] ${err.message}`);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  const command = args.command || 'check';
  const policyUrl = args.manifest || configuredPolicyUrl() || DEFAULT_POLICY_URL;
  const release = await resolveRelease(policyUrl);
  const newer = compareVersions(currentVersion, release.version) < 0;

  console.log(`[update] Current: ${currentVersion}`);
  console.log(`[update] Latest:  ${release.version}`);
  if (!newer && !args.force) {
    console.log('[update] VoxHF is up to date.');
    return;
  }
  if (command === 'check') {
    console.log(`[update] ${newer ? 'An update is available.' : 'No newer version; --force would retest this release.'}`);
    return;
  }

  const output = path.resolve(args.output || path.join(root, 'updates', release.artifact.file));
  await downloadArtifact(release, output);
  console.log(`[update] Verified download: ${output}`);
  if (command === 'download') return;
  if (command !== 'stage') throw new Error(`Unknown command: ${command}`);

  const destination = path.resolve(args.destination || path.join(path.dirname(root), `VoxHF-${release.version}`));
  stageArchive(output, destination, release.version);
  console.log(`[update] Staged installation: ${destination}`);
  console.log('[update] Stop the current proxy, start the new folder, and keep the old folder until flight testing passes.');
}

async function resolveRelease(policyUrl) {
  const policy = await fetchJson(policyUrl, MAX_JSON_BYTES);
  const version = String(policy.latestVersion || policy.recommendedLocalVersion || '').trim().replace(/^v/i, '');
  if (!/^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.:-]+)?$/.test(version)) throw new Error('Release policy has no valid latestVersion.');
  const artifactsUrl = String(policy.artifactsUrl || '').trim()
    || `https://github.com/leledeste/voxhf/releases/download/v${version}/release-artifacts.json`;
  const artifactManifest = await fetchJson(artifactsUrl, MAX_JSON_BYTES);
  if (String(artifactManifest.version || '').replace(/^v/i, '') !== version) {
    throw new Error('Release policy and artifact manifest versions differ.');
  }
  const artifact = (artifactManifest.artifacts || []).find((item) => item.id === 'local');
  if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || '')) throw new Error('Local artifact/checksum is missing.');
  return {
    version,
    artifactsUrl,
    artifact: {
      file: path.basename(String(artifact.file || '')),
      sha256: artifact.sha256.toLowerCase(),
      bytes: Number(artifact.bytes) || 0,
      url: new URL(String(artifact.url || artifact.file), artifactsUrl).toString(),
    },
  };
}

async function downloadArtifact(release, output) {
  if (!release.artifact.file) throw new Error('Artifact filename is invalid.');
  if (fs.existsSync(output)) {
    const data = fs.readFileSync(output);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== release.artifact.sha256 || (release.artifact.bytes && data.length !== release.artifact.bytes)) {
      throw new Error(`Existing update download failed verification: ${output}`);
    }
    return;
  }
  requireSecureUpdateUrl(release.artifact.url);
  const response = await fetch(release.artifact.url, { redirect: 'follow' });
  requireSecureUpdateUrl(response.url);
  if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`);
  const announced = Number(response.headers.get('content-length')) || release.artifact.bytes;
  if (announced > MAX_ARCHIVE_BYTES) throw new Error('Artifact exceeds the download size limit.');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > MAX_ARCHIVE_BYTES) throw new Error('Artifact is empty or too large.');
  if (release.artifact.bytes && data.length !== release.artifact.bytes) throw new Error('Artifact size does not match the manifest.');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== release.artifact.sha256) throw new Error('Artifact SHA-256 verification failed.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, data, { flag: 'wx' });
}

function stageArchive(archive, destination, expectedVersion) {
  if (process.platform !== 'win32') throw new Error('Local staging is currently supported on Windows only.');
  if (fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-update-'));
  try {
    const command = [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${powerShellLiteral(archive)} -DestinationPath ${powerShellLiteral(temporary)} -Force`,
    ];
    const result = spawnSync('powershell.exe', command, { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not extract update.').trim());
    const entries = fs.readdirSync(temporary, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('Update ZIP must contain one top-level folder.');
    const extracted = path.join(temporary, entries[0].name);
    const metadata = JSON.parse(fs.readFileSync(path.join(extracted, 'VOXHF_RELEASE.json'), 'utf8'));
    if (metadata.package !== 'local' || metadata.version !== expectedVersion) throw new Error('Update package metadata is invalid.');
    fs.cpSync(extracted, destination, { recursive: true, errorOnExist: true });
    const config = path.join(root, 'config.json');
    if (fs.existsSync(config)) fs.copyFileSync(config, path.join(destination, 'config.json'), fs.constants.COPYFILE_EXCL);
  } catch (err) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function fetchJson(url, maxBytes) {
  const parsed = requireSecureUpdateUrl(url);
  const response = await fetch(parsed, { cache: 'no-store', redirect: 'follow' });
  requireSecureUpdateUrl(response.url);
  if (!response.ok) throw new Error(`Update metadata failed: HTTP ${response.status}`);
  const announced = Number(response.headers.get('content-length')) || 0;
  if (announced > maxBytes) throw new Error('Update metadata exceeds the size limit.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Update metadata exceeds the size limit.');
  return JSON.parse(text);
}

function requireSecureUpdateUrl(value) {
  const parsed = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('Remote update URLs must use HTTPS.');
  }
  return parsed;
}

function configuredPolicyUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    return String(config.updateCheckUrl || '').trim();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const result = { command: '', manifest: '', output: '', destination: '', force: false, help: false };
  const args = [...argv];
  while (args.length) {
    const value = args.shift();
    if (value === '-h' || value === '--help') result.help = true;
    else if (value === '--force') result.force = true;
    else if (value === '--manifest') result.manifest = args.shift() || '';
    else if (value === '--output') result.output = args.shift() || '';
    else if (value === '--destination') result.destination = args.shift() || '';
    else if (!result.command) result.command = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return result;
}

function printHelp() {
  console.log(`VoxHF Local updater

Usage:
  npm run update:check
  npm run update:download
  npm run update:stage

Options:
  --manifest URL       Override release.json URL
  --output FILE        Override downloaded ZIP path
  --destination DIR    Override staged installation folder
  --force              Download/stage even when versions are equal`);
}

module.exports = { downloadArtifact, fetchJson, resolveRelease, stageArchive };
