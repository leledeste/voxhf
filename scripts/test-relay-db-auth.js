'use strict';

// Relay DB-auth smoke test.
//
// This starts real relay processes on temporary localhost ports. It verifies
// that .env-only mode ignores SQLite, that SQLite tokens can authenticate
// clients, that .env fallback still works in migration mode, and that
// SQLite-only mode disables that fallback.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { importRelayUserToken, openRelayDatabase } = require('../apps/relay/db');
const { MESSAGE_TYPES } = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const allowedOrigin = 'https://app.example.test';

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
});

async function main() {
  await assertEnvOnlyModeIgnoresDatabase();
  await assertDbAuthWithEnvFallback();
  await assertDbAuthStrictMode();
  console.log('[OK] relay SQLite auth');
}

async function assertEnvOnlyModeIgnoresDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-env-auth-'));
  let relay = null;

  try {
    const port = await getFreePort();
    relay = await startRelay({
      port,
      dataDir: tempDir,
      authMode: 'env',
      dbFile: path.join(tempDir, 'missing', 'should-not-open.db'),
      envUsers: 'envuser=env-token-22222222222222222222222222222222',
    });

    const baseWs = `ws://127.0.0.1:${port}/ws`;
    await assertConnectsAs(baseWs, 'env-token-22222222222222222222222222222222', 'envuser');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertDbAuthWithEnvFallback() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-db-auth-'));
  let relay = null;

  try {
    const dbFile = path.join(tempDir, 'voxhf.db');
    seedDatabase(dbFile, 'primary', 'primary-token-00000000000000000000000000000000');

    const port = await getFreePort();
    relay = await startRelay({
      port,
      dataDir: tempDir,
      dbFile,
      authMode: 'sqlite-fallback',
      envUsers: 'fallback=fallback-token-00000000000000000000000000000000',
    });

    const baseWs = `ws://127.0.0.1:${port}/ws`;
    await assertRejected(baseWs, 'bad-token-00000000000000000000000000000000');
    await assertConnectsAs(baseWs, 'primary-token-00000000000000000000000000000000', 'primary');
    await assertConnectsAs(baseWs, 'fallback-token-00000000000000000000000000000000', 'fallback');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertDbAuthStrictMode() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-db-auth-sqlite-'));
  let relay = null;

  try {
    const dbFile = path.join(tempDir, 'voxhf.db');
    seedDatabase(dbFile, 'primary', 'primary-token-11111111111111111111111111111111');

    const port = await getFreePort();
    relay = await startRelay({
      port,
      dataDir: tempDir,
      dbFile,
      authMode: 'sqlite',
      envUsers: 'fallback=fallback-token-11111111111111111111111111111111',
    });

    const baseWs = `ws://127.0.0.1:${port}/ws`;
    await assertConnectsAs(baseWs, 'primary-token-11111111111111111111111111111111', 'primary');
    await assertRejected(baseWs, 'fallback-token-11111111111111111111111111111111');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function seedDatabase(dbFile, userId, token) {
  const db = openRelayDatabase({ filename: dbFile });
  try {
    importRelayUserToken(db, {
      userId,
      displayName: userId,
      token,
      tokenName: 'Test token',
    });
  } finally {
    db.close();
  }
}

async function startRelay(options) {
  const relayProcess = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      VOXHF_RELAY_HOST: '127.0.0.1',
      VOXHF_RELAY_PORT: String(options.port),
      VOXHF_RELAY_AUTH_MODE: options.authMode,
      VOXHF_RELAY_DATABASE: options.dbFile,
      VOXHF_RELAY_USERS: options.envUsers || '',
      VOXHF_RELAY_TOKEN: '',
      VOXHF_ALLOWED_ORIGINS: allowedOrigin,
      VOXHF_RELAY_REQUIRE_PAIRING: 'true',
      VOXHF_PAIRING_TTL_MS: '600000',
      VOXHF_RELAY_PERSIST_PAIRINGS: 'true',
      VOXHF_RELAY_DATA_DIR: options.dataDir,
      VOXHF_RELAY_PAIRINGS_FILE: path.join(options.dataDir, 'pairings.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  relayProcess.stdout.on('data', (chunk) => { output += chunk.toString(); });
  relayProcess.stderr.on('data', (chunk) => { output += chunk.toString(); });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${options.port}/health`).catch(() => null);
    return response && response.ok;
  }, () => `relay startup\n${output.trim()}`);

  return relayProcess;
}

async function assertConnectsAs(baseWs, token, userId) {
  const ws = new WebSocket(`${baseWs}?source=browser&token=${encodeURIComponent(token)}&browserId=browser-${userId}`, {
    origin: allowedOrigin,
  });
  const messages = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString('utf8')));
  });

  await onceOpen(ws);
  const identity = await waitForMessage(messages, (message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  assert.strictEqual(identity.payload.userId, userId, `token should authenticate as ${userId}`);
  ws.close();
}

async function assertRejected(baseWs, token) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWs}?source=browser&token=${encodeURIComponent(token)}&browserId=browser-bad`, {
      origin: allowedOrigin,
    });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('invalid token was not rejected'));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('invalid token unexpectedly connected'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      assert.ok(res.statusCode >= 400, 'invalid token should receive HTTP error');
      resolve();
    });
    ws.once('error', () => {});
  });
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForMessage(messages, predicate, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = messages.find(predicate);
    if (match) return match;
    await delay(25);
  }
  throw new Error('timed out waiting for relay message');
}

async function stopRelay(relayProcess) {
  if (!relayProcess || relayProcess.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { relayProcess.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 1500);
    relayProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { relayProcess.kill(); } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(typeof label === 'function' ? label() : `Timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
