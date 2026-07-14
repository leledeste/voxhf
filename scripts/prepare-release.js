'use strict';

// Build focused release folders and ZIP archives from release-manifest.json.
//
// The repository remains unified, while every artifact is self-contained.
// Copying is handled here instead of fs.cp(): ignored local files such as .env,
// config.json, databases, and logs must never enter a public release.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yazl = require('yazl');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const packageJson = readJson(path.join(root, 'package.json'));
const packageLock = readJson(path.join(root, 'package-lock.json'));
const manifest = readJson(path.join(root, 'release-manifest.json'));

const FORBIDDEN_DIRECTORIES = new Set([
  '.agents', '.codex', '.git', '.voxhf-relay', 'backups', 'dist',
  'node_modules', 'private', 'release', 'temp', 'tmp', 'tx-inspect', 'updates', 'voice-dumps',
]);
const FORBIDDEN_EXTENSIONS = new Set([
  '.bin', '.db', '.dump', '.log', '.pcm', '.raw', '.sqlite', '.sqlite3',
]);

main().catch((err) => {
  console.error(`[release] ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  validateReleasePolicy();
  assertInsideRoot(distDir);
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const artifacts = [];
  for (const [id, spec] of Object.entries(manifest.packages || {})) {
    artifacts.push(await buildPackage(id, spec));
  }

  writeArtifactManifest(artifacts);
  console.log(`[OK] release artifacts written to ${path.relative(root, distDir)}`);
}

function validateReleasePolicy() {
  const policy = readJson(path.join(root, 'webapp', 'release.json'));
  if (policy.latestVersion !== packageJson.version || policy.recommendedLocalVersion !== packageJson.version) {
    throw new Error('package.json and webapp/release.json versions differ; run npm run release:version first.');
  }
}

async function buildPackage(id, spec) {
  const directory = spec.directory || id;
  const targetDir = path.join(distDir, directory);
  assertInsideDist(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const item of spec.paths || []) copyManifestPath(item, targetDir);

  if (spec.packageJson) {
    const generatedPackage = writePackageJson(targetDir, spec.packageJson, spec.description);
    writePackageLock(targetDir, generatedPackage);
  }

  const metadata = packageMetadata(id, spec);
  fs.writeFileSync(path.join(targetDir, 'VOXHF_RELEASE.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  fs.writeFileSync(path.join(targetDir, 'README_PACKAGE.txt'), packageReadme(id, spec));
  scanReleaseTree(targetDir);

  const archiveName = `${directory}-${packageJson.version}.zip`;
  const archivePath = path.join(distDir, archiveName);
  await zipDirectory(targetDir, archivePath, directory);
  const sha256 = sha256File(archivePath);

  console.log(`[OK] ${spec.name || id} -> ${path.relative(root, archivePath)} (${formatBytes(fs.statSync(archivePath).size)})`);
  return {
    id,
    name: spec.name || id,
    version: packageJson.version,
    file: archiveName,
    bytes: fs.statSync(archivePath).size,
    sha256,
  };
}

function copyManifestPath(relativePath, targetDir) {
  const source = path.join(root, relativePath);
  if (!fs.existsSync(source)) throw new Error(`Release path is missing: ${relativePath}`);
  assertInsideRoot(source);
  const destination = path.join(targetDir, relativePath);
  assertInsideDist(destination);
  copySafe(source, destination, relativePath);
}

function copySafe(source, destination, releasePath) {
  if (isForbiddenPath(releasePath)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Release paths may not contain symbolic links: ${releasePath}`);

  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      copySafe(path.join(source, name), path.join(destination, name), path.join(releasePath, name));
    }
    return;
  }

  if (!stat.isFile()) throw new Error(`Unsupported release entry: ${releasePath}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function isForbiddenPath(candidate) {
  const parts = candidate.replace(/\\/g, '/').split('/').filter(Boolean);
  const basename = String(parts.at(-1) || '').toLowerCase();
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => FORBIDDEN_DIRECTORIES.has(part) || part.startsWith('backup-'))) return true;
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) return true;
  if (basename === 'config.json') return true;
  return FORBIDDEN_EXTENSIONS.has(path.extname(basename));
}

function scanReleaseTree(targetDir) {
  for (const file of walkFiles(targetDir)) {
    const relative = path.relative(targetDir, file);
    if (isForbiddenPath(relative)) throw new Error(`Forbidden file entered release: ${relative}`);
  }
}

function writePackageJson(targetDir, spec, description) {
  // Runtime artifacts contain no root development tools or unrelated server
  // dependencies. This keeps local installations small and auditable.
  const names = Array.isArray(spec.dependencies) ? spec.dependencies : Object.keys(packageJson.dependencies || {});
  const dependencies = {};
  for (const name of names) {
    if (!packageJson.dependencies?.[name]) throw new Error(`Unknown release dependency: ${name}`);
    dependencies[name] = packageJson.dependencies[name];
  }

  const generated = {
    name: packageJson.name,
    version: packageJson.version,
    description: description || packageJson.description,
    main: spec.main || packageJson.main,
    license: packageJson.license,
    scripts: spec.scripts || {},
    engines: packageJson.engines,
    dependencies,
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), `${JSON.stringify(generated, null, 2)}\n`);
  return generated;
}

function writePackageLock(targetDir, generatedPackage) {
  const packages = {
    '': {
      name: generatedPackage.name,
      version: generatedPackage.version,
      license: generatedPackage.license,
      dependencies: generatedPackage.dependencies,
      engines: generatedPackage.engines,
    },
  };
  for (const packagePath of dependencyClosure(Object.keys(generatedPackage.dependencies || {}))) {
    packages[packagePath] = packageLock.packages[packagePath];
  }
  const generatedLock = {
    name: generatedPackage.name,
    version: generatedPackage.version,
    lockfileVersion: packageLock.lockfileVersion,
    requires: true,
    packages,
  };
  fs.writeFileSync(path.join(targetDir, 'package-lock.json'), `${JSON.stringify(generatedLock, null, 2)}\n`);
}

function dependencyClosure(rootDependencies) {
  const selected = new Set();
  const queue = rootDependencies.map((name) => ({ name, parentPath: '' }));
  while (queue.length) {
    const dependency = queue.shift();
    const packagePath = resolveLockedPackage(dependency.name, dependency.parentPath);
    if (!packagePath || selected.has(packagePath)) continue;
    selected.add(packagePath);
    const record = packageLock.packages[packagePath] || {};
    for (const name of Object.keys(record.dependencies || {})) queue.push({ name, parentPath: packagePath });
    for (const name of Object.keys(record.optionalDependencies || {})) queue.push({ name, parentPath: packagePath });
    for (const name of Object.keys(record.peerDependencies || {})) {
      if (!record.peerDependenciesMeta?.[name]?.optional && resolveLockedPackage(name, packagePath)) {
        queue.push({ name, parentPath: packagePath });
      }
    }
  }
  return [...selected].sort();
}

function resolveLockedPackage(name, parentPath = '') {
  let ancestor = parentPath;
  while (ancestor) {
    const nested = `${ancestor}/node_modules/${name}`;
    if (packageLock.packages[nested]) return nested;
    const marker = ancestor.lastIndexOf('node_modules/');
    ancestor = marker > 0 ? ancestor.slice(0, marker).replace(/\/$/, '') : '';
  }
  const direct = `node_modules/${name}`;
  if (packageLock.packages[direct]) return direct;
  const suffix = `/node_modules/${name}`;
  return Object.keys(packageLock.packages).filter((key) => key.endsWith(suffix)).sort((a, b) => a.length - b.length)[0] || '';
}

function packageMetadata(id, spec) {
  return {
    format: 1,
    package: id,
    name: spec.name || id,
    version: packageJson.version,
    sourceCommit: sourceCommit(),
  };
}

function packageReadme(id, spec) {
  const lines = [
    spec.name || id,
    '='.repeat((spec.name || id).length),
    '',
    `Version: ${packageJson.version}`,
    '',
    spec.description || '',
    '',
    'This is a generated VoxHF release package.',
  ];
  if (spec.installDocument) lines.push(`Installation: ${spec.installDocument}`, '');
  for (const [index, instruction] of (spec.quickStart || []).entries()) {
    lines.push(`${index + 1}. ${instruction}`);
  }
  lines.push('', 'See README.md for product usage and safety information.', '');
  return lines.join('\n');
}

function writeArtifactManifest(artifacts) {
  const release = {
    format: 1,
    version: packageJson.version,
    sourceCommit: sourceCommit(),
    artifacts,
  };
  fs.writeFileSync(path.join(distDir, 'release-artifacts.json'), `${JSON.stringify(release, null, 2)}\n`);
  fs.writeFileSync(path.join(distDir, 'SHA256SUMS.txt'), `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join('\n')}\n`);
}

function zipDirectory(sourceDir, archivePath, rootName) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(archivePath, { flags: 'wx' });
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    for (const file of walkFiles(sourceDir)) {
      const relative = path.relative(sourceDir, file).replace(/\\/g, '/');
      zip.addFile(file, `${rootName}/${relative}`, { mtime: fs.statSync(file).mtime });
    }
    zip.end();
  });
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`Unsupported release entry: ${fullPath}`);
  }
  return files;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'source-archive';
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function assertInsideRoot(candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes repository root: ${candidate}`);
}

function assertInsideDist(candidate) {
  const relative = path.relative(distDir, path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes dist directory: ${candidate}`);
}
