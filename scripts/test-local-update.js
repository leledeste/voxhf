'use strict';

// Serve generated releases locally. Staging uses a synthetic installation,
// never the developer's real configuration or notification credentials.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const artifacts = JSON.parse(fs.readFileSync(path.join(dist, 'release-artifacts.json'), 'utf8'));
const local = artifacts.artifacts.find((artifact) => artifact.id === 'local');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-update-test-'));

// Load the real updater from a fixture root so its source-of-truth paths point
// at disposable settings. Spaces, apostrophes, and brackets exercise quoting.
const installation = path.join(temporary, "Pilot's installation [test]");
for (const relative of ['scripts/update-local.js', 'packages/protocol/index.js', 'package.json']) {
  const target = path.join(installation, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}
const privateFiles = {
  'config.json': '{"remoteDeviceId":"updater-test","remoteRelayToken":"synthetic-test-token"}\n',
  '.voxhf-local/notifications.json': '{"subscriptions":["synthetic-subscription"]}\n',
  '.voxhf-local/nested/credentials.json': '{"privateKey":"synthetic-test-key"}\n',
};
for (const [relative, content] of Object.entries(privateFiles)) {
  fs.mkdirSync(path.dirname(path.join(installation, relative)), { recursive: true });
  fs.writeFileSync(path.join(installation, relative), content);
}
const { resolveRelease, downloadArtifact, stageArchive } = require(path.join(installation, 'scripts/update-local'));

const server = http.createServer((req, res) => {
  if (req.url === '/release.json') return json(res, {
    latestVersion: artifacts.version,
    artifactsUrl: `http://127.0.0.1:${server.address().port}/release-artifacts.json`,
  });
  if (req.url === '/release-artifacts.json') return json(res, artifacts);
  if (req.url === `/${local.file}`) {
    const data = fs.readFileSync(path.join(dist, local.file));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': data.length });
    res.end(data);
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const release = await resolveRelease(`http://127.0.0.1:${server.address().port}/release.json`);
    assert.strictEqual(release.version, artifacts.version);
    const output = path.join(temporary, "Pilot's download [test].zip");
    await downloadArtifact(release, output);
    assert.strictEqual(fs.statSync(output).size, local.bytes);
    await downloadArtifact(release, output);
    await assert.rejects(downloadArtifact({
      ...release, artifact: { ...release.artifact, sha256: '0'.repeat(64) },
    }, output), /failed verification/);
    await assert.rejects(downloadArtifact({
      ...release, artifact: { ...release.artifact, bytes: local.bytes + 1 },
    }, output), /failed verification/);
    if (process.platform === 'win32') {
      const originalModulePath = process.env.PSModulePath;
      try {
        for (const mode of ['inherited', 'foreign', 'absent']) {
          if (mode === 'foreign') {
            // Reproduce an intermediate host passing module paths that omit
            // Windows PowerShell's built-in Archive module entirely.
            const foreign = path.join(temporary, 'foreign modules');
            fs.mkdirSync(foreign);
            process.env.PSModulePath = foreign;
          } else if (mode === 'absent') {
            delete process.env.PSModulePath;
          }
          const before = process.env.PSModulePath;
          const staged = path.join(temporary, `Pilot's staged [${mode}]`);
          stageArchive(output, staged, release.version);
          assert.strictEqual(process.env.PSModulePath, before, 'parent environment must not change');
          assert.ok(fs.existsSync(path.join(staged, 'start.bat')), 'staged Local package should be runnable');
          const metadata = JSON.parse(fs.readFileSync(path.join(staged, 'VOXHF_RELEASE.json'), 'utf8'));
          assert.strictEqual(metadata.version, release.version);
          assert.strictEqual(metadata.package, 'local');
          for (const [relative, content] of Object.entries(privateFiles)) {
            assert.strictEqual(fs.readFileSync(path.join(staged, relative), 'utf8'), content);
            assert.strictEqual(fs.readFileSync(path.join(installation, relative), 'utf8'), content);
          }
          assert.throws(() => stageArchive(output, staged, release.version), /Destination already exists/);
          assert.ok(fs.existsSync(path.join(staged, 'start.bat')), 'existing destination must survive rejection');
        }
        const rejected = path.join(temporary, 'rejected-version');
        assert.throws(() => stageArchive(output, rejected, 'invalid-version'), /metadata is invalid/);
        assert.ok(!fs.existsSync(rejected), 'invalid metadata must not leave an installation');
        const corrupt = path.join(temporary, 'corrupt.zip');
        fs.writeFileSync(corrupt, 'not a zip');
        const incomplete = path.join(temporary, 'failed-extraction');
        assert.throws(() => stageArchive(corrupt, incomplete, release.version));
        assert.ok(!fs.existsSync(incomplete), 'failed extraction must not leave an installation');
      } finally {
        if (originalModulePath === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = originalModulePath;
      }
      console.log('[OK] Windows staging: module-path isolation, literal paths, private-state preservation and failures');
    } else {
      console.log('[SKIP] Windows extraction requires Windows; download verification still runs');
    }
    console.log('[OK] verified Local update download');
  } catch (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    // Only remove the unique fixture directory created by mkdtemp above.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function json(res, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}
