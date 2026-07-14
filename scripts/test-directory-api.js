'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  createDirectoryServer,
  hashToken,
  openRelayDatabase,
} = require('../apps/relay/db');

const root = path.resolve(__dirname, '..');

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-directory-api-'));
  const dbFile = path.join(tempDir, 'voxhf.db');
  const token = crypto.randomBytes(32).toString('hex');
  let relay;

  try {
    const db = openRelayDatabase({ filename: dbFile });
    createDirectoryServer(db, {
      slug: 'voxhf-community',
      name: 'VoxHF Community',
      operator: 'VoxHF project',
      region: 'Europe',
      access: 'invite',
      appUrl: 'https://app.voxhf.com/',
      relayUrl: 'https://relay.voxhf.com/',
      description: 'Official preview relay',
      privacyUrl: 'https://voxhf.com/privacy.html',
      sourceUrl: 'https://github.com/leledeste/voxhf',
      tokenHash: hashToken(token),
      official: true,
    });
    db.close();

    const port = await freePort();
    relay = await startRelay(port, tempDir, dbFile);
    const base = `http://127.0.0.1:${port}`;

    const initial = await jsonFetch(`${base}/directory/api/servers`);
    assert.strictEqual(initial.status, 200);
    assert.strictEqual(initial.body.servers[0].official, true);
    assert.strictEqual(initial.body.servers[0].status, 'offline');

    const rejected = await jsonFetch(`${base}/directory/api/heartbeat`, {
      method: 'POST',
      token: crypto.randomBytes(32).toString('hex'),
      body: { version: '0.1.0', registrationOpen: true, official: false },
    });
    assert.strictEqual(rejected.status, 401);

    const accepted = await jsonFetch(`${base}/directory/api/heartbeat`, {
      method: 'POST',
      token,
      body: { version: '0.1.0', registrationOpen: true, official: false, name: 'Forged name' },
    });
    assert.strictEqual(accepted.status, 200);

    const live = await jsonFetch(`${base}/directory/api/servers`);
    assert.strictEqual(live.body.servers[0].status, 'online');
    assert.strictEqual(live.body.servers[0].name, 'VoxHF Community');
    assert.strictEqual(live.body.servers[0].official, true);
    assert.strictEqual(live.body.servers[0].registrationOpen, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(live.body.servers[0], 'tokenHash'));

    // The registry rejects repeated invalid heartbeat credentials before they
    // can turn into unlimited database work from one source address.
    let limited;
    for (let index = 0; index < 9; index += 1) {
      limited = await jsonFetch(`${base}/directory/api/heartbeat`, {
        method: 'POST',
        token: crypto.randomBytes(32).toString('hex'),
        body: { version: '0.1.0' },
      });
    }
    assert.strictEqual(limited.status, 429);
    console.log('[OK] public directory HTTP API');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function startRelay(port, dataDir, dbFile) {
  const child = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      VOXHF_RELAY_HOST: '127.0.0.1',
      VOXHF_RELAY_PORT: String(port),
      VOXHF_RELAY_AUTH_MODE: 'env',
      VOXHF_RELAY_TOKEN: 'directory-test-relay-token-00000000000000',
      VOXHF_RELAY_DATABASE: dbFile,
      VOXHF_RELAY_DATA_DIR: dataDir,
      VOXHF_DIRECTORY_REGISTRY_ENABLED: 'true',
      VOXHF_DIRECTORY_ONLINE_TTL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (!output.includes('[relay] Listening')) {
    if (child.exitCode !== null) throw new Error(`Relay exited early:\n${output}`);
    if (Date.now() > deadline) throw new Error(`Relay did not start:\n${output}`);
    await delay(25);
  }
  return child;
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2000).then(() => child.kill('SIGKILL')),
  ]);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
