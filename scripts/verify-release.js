'use strict';

// Verify the actual ZIP files that users receive, not only their source
// folders. Structural checks are fast and always run. Pass --install to also
// perform clean npm installs and runtime smoke tests inside extracted copies.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yauzl = require('yauzl');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const install = process.argv.includes('--install');
const manifestFile = path.join(distDir, 'release-artifacts.json');
const forbiddenNames = new Set(['.env', 'config.json']);
const forbiddenDirectories = new Set(['.git', '.voxhf-relay', 'backups', 'node_modules', 'updates', 'voice-dumps']);
const forbiddenExtensions = new Set(['.db', '.log', '.pcm', '.raw', '.sqlite', '.sqlite3']);

main().catch((err) => {
  console.error(`[release verify] ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  if (!fs.existsSync(manifestFile)) fail('Run npm run release:prepare first.');
  const release = readJson(manifestFile);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-release-'));

  try {
    for (const artifact of release.artifacts || []) await verifyArtifact(release, artifact, tempRoot);
    verifyChecksumsFile(release);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`[OK] ${release.artifacts.length} release packages verified${install ? ' with clean installs' : ''}.`);
}

async function verifyArtifact(release, artifact, tempRoot) {
  const archive = path.join(distDir, artifact.file);
  if (!fs.existsSync(archive)) fail(`Missing archive: ${artifact.file}`);
  const actualHash = sha256File(archive);
  if (actualHash !== artifact.sha256) fail(`Checksum mismatch: ${artifact.file}`);

  const extractRoot = path.join(tempRoot, artifact.id);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(archive, extractRoot);

  const packageRoot = onlyTopLevelDirectory(extractRoot);
  scanForPrivateFiles(packageRoot);
  const metadata = readJson(path.join(packageRoot, 'VOXHF_RELEASE.json'));
  if (metadata.package !== artifact.id || metadata.version !== release.version) {
    fail(`Release metadata mismatch in ${artifact.file}`);
  }

  verifyCommonFiles(packageRoot);
  if (artifact.id === 'local') verifyLocal(packageRoot);
  else if (artifact.id === 'hosted-webapp') verifyHosted(packageRoot);
  else if (artifact.id === 'server') verifyServer(packageRoot);
  else if (artifact.id === 'full-source') verifyFullSource(packageRoot);
  else fail(`Unknown package id: ${artifact.id}`);

  console.log(`[OK] ${artifact.file}`);
}

function verifyCommonFiles(packageRoot) {
  requireFiles(packageRoot, ['README.md', 'README_PACKAGE.txt', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE']);
}

function verifyLocal(packageRoot) {
  requireFiles(packageRoot, [
    'package.json', 'package-lock.json', 'proxy.js', 'start.bat',
    'config.example.json', 'webapp/app.html', 'packages/protocol/index.js',
  ]);
  verifyLockMatchesPackage(packageRoot);
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  if (JSON.stringify(Object.keys(pkg.dependencies || {})) !== JSON.stringify(['ws'])) {
    fail('Local Slim must depend only on ws');
  }
  for (const forbidden of ['apps', 'infra', 'apps/relay', 'infra/docker']) {
    if (fs.existsSync(path.join(packageRoot, forbidden))) fail(`Local Slim contains server path: ${forbidden}`);
  }
  checkNodeSyntax(path.join(packageRoot, 'proxy.js'));
  if (install) {
    runNpm(packageRoot, ['ci', '--omit=dev']);
    runNode(packageRoot, ['-e', "require('ws'); require('./packages/protocol')"]);
  }
}

function verifyHosted(packageRoot) {
  requireFiles(packageRoot, ['webapp/index.html', 'webapp/login.html', 'webapp/app.html', 'webapp/app.js', 'webapp/styles.css']);
  verifyHtmlReferences(path.join(packageRoot, 'webapp'));
}

function verifyServer(packageRoot) {
  requireFiles(packageRoot, [
    'package.json', 'package-lock.json', 'apps/relay/index.js',
    'apps/relay/.env.example', 'infra/docker/.env.example',
    'infra/docker/docker-compose.yml', 'infra/docker/relay.Dockerfile',
  ]);
  verifyLockMatchesPackage(packageRoot);
  checkNodeSyntax(path.join(packageRoot, 'apps/relay/index.js'));
  if (install) {
    runNpm(packageRoot, ['ci', '--omit=dev']);
    runNode(packageRoot, ['-e', "require('ws'); require('better-sqlite3'); require('./packages/protocol')"]);
  }
}

function verifyFullSource(packageRoot) {
  requireFiles(packageRoot, [
    'package.json', 'package-lock.json', 'scripts/check.js',
    'scripts/prepare-release.js', 'proxy.js', 'apps/relay/index.js',
  ]);
  verifyLockMatchesPackage(packageRoot);
  checkNodeSyntax(path.join(packageRoot, 'proxy.js'));
  if (install) {
    runNpm(packageRoot, ['ci']);
    runNpm(packageRoot, ['run', 'verify']);
  }
}

function verifyLockMatchesPackage(packageRoot) {
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const lock = readJson(path.join(packageRoot, 'package-lock.json'));
  const lockedRoot = lock.packages?.[''] || {};
  if (pkg.name !== lock.name || pkg.version !== lock.version) fail(`Lock metadata mismatch in ${packageRoot}`);
  if (JSON.stringify(pkg.dependencies || {}) !== JSON.stringify(lockedRoot.dependencies || {})) {
    fail(`Lock dependencies mismatch in ${packageRoot}`);
  }
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    if (!lock.packages?.[`node_modules/${dependency}`]) fail(`Lock is missing ${dependency} in ${packageRoot}`);
  }
}

function verifyHtmlReferences(webRoot) {
  for (const htmlFile of fs.readdirSync(webRoot).filter((name) => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(webRoot, htmlFile), 'utf8');
    const references = [...html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/gi)].map((match) => match[1]);
    for (const reference of references) {
      if (/^(?:https?:|mailto:|\/)/i.test(reference)) continue;
      const target = path.resolve(webRoot, reference);
      if (!target.startsWith(path.resolve(webRoot)) || !fs.existsSync(target)) {
        fail(`Broken web reference ${reference} in ${htmlFile}`);
      }
    }
  }
}

function scanForPrivateFiles(packageRoot) {
  for (const file of walkFiles(packageRoot)) {
    const relative = path.relative(packageRoot, file).replace(/\\/g, '/');
    const parts = relative.toLowerCase().split('/');
    const basename = parts.at(-1);
    const extension = path.extname(basename);
    if (forbiddenDirectories.has(parts[0]) || parts.some((part) => forbiddenDirectories.has(part))) {
      fail(`Private directory in release: ${relative}`);
    }
    if (forbiddenNames.has(basename) || (basename.startsWith('.env.') && basename !== '.env.example')) {
      fail(`Private file in release: ${relative}`);
    }
    if (forbiddenExtensions.has(extension)) fail(`Private diagnostic/data file in release: ${relative}`);
  }
}

function verifyChecksumsFile(release) {
  const expected = `${release.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join('\n')}\n`;
  const actual = fs.readFileSync(path.join(distDir, 'SHA256SUMS.txt'), 'utf8').replace(/\r\n/g, '\n');
  if (actual !== expected) fail('SHA256SUMS.txt does not match release-artifacts.json');
}

function extractZip(zipPath, targetRoot) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.readEntry();
      zip.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (name.startsWith('/') || name.split('/').includes('..')) return reject(new Error(`Unsafe ZIP entry: ${name}`));
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return reject(new Error(`Symbolic links are forbidden in ZIP: ${name}`));
        const destination = path.resolve(targetRoot, name);
        if (!destination.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) return reject(new Error(`ZIP entry escapes target: ${name}`));

        if (name.endsWith('/')) {
          fs.mkdirSync(destination, { recursive: true });
          zip.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        zip.openReadStream(entry, (streamError, input) => {
          if (streamError) return reject(streamError);
          const output = fs.createWriteStream(destination, { flags: 'wx' });
          input.on('error', reject);
          output.on('error', reject);
          output.on('close', () => zip.readEntry());
          input.pipe(output);
        });
      });
    });
  });
}

function onlyTopLevelDirectory(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) fail(`Archive must contain one top-level directory: ${directory}`);
  return path.join(directory, entries[0].name);
}

function requireFiles(base, relativeFiles) {
  for (const relative of relativeFiles) {
    if (!fs.existsSync(path.join(base, relative))) fail(`Package is missing ${relative}`);
  }
}

function checkNodeSyntax(file) {
  run(process.execPath, ['--check', file], path.dirname(file));
}

function runNpm(cwd, args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    run(process.execPath, [npmCli, ...args], cwd);
    return;
  }
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(command, args, cwd);
}

function runNode(cwd, args) {
  run(process.execPath, args, cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
  });
  if (result.error) fail(`${command} could not start in ${cwd}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed in ${cwd}${output ? `\n${output}` : ''}`);
  }
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  if (!fs.existsSync(file)) fail(`Missing JSON file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function fail(message) {
  throw new Error(message);
}
