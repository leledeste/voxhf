'use strict';

// Serve the generated release metadata locally and verify that the updater
// downloads the Local ZIP only when its size and SHA-256 match.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { resolveRelease, downloadArtifact, stageArchive } = require('./update-local');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const artifacts = JSON.parse(fs.readFileSync(path.join(dist, 'release-artifacts.json'), 'utf8'));
const local = artifacts.artifacts.find((artifact) => artifact.id === 'local');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-update-test-'));

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
    const output = path.join(temporary, local.file);
    await downloadArtifact(release, output);
    assert.strictEqual(fs.statSync(output).size, local.bytes);
    await downloadArtifact(release, output);
    if (process.platform === 'win32') {
      const staged = path.join(temporary, 'staged');
      stageArchive(output, staged, release.version);
      assert.ok(fs.existsSync(path.join(staged, 'start.bat')), 'staged Local package should be runnable');
      assert.ok(fs.existsSync(path.join(staged, 'VOXHF_RELEASE.json')), 'staged metadata should be retained');
    }
    console.log('[OK] verified Local update download');
  } catch (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function json(res, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}
