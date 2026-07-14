'use strict';

// End-to-end Remote Preview smoke test.
//
// This starts a real relay process on a temporary localhost port, then simulates
// one VoxHF agent and one remote browser. It verifies the security boundary
// that matters most before a VPS deployment: health/CORS, token/origin-gated
// WebSockets, pairing, allowlisted browser commands, agent updates, live audio
// routing in both directions, and revoke.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const {
  MESSAGE_TYPES,
  createRemoteMessage,
} = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const token = `test-token-${Date.now().toString(36)}`;
const otherToken = `other-token-${Date.now().toString(36)}`;
const allowedOrigin = 'https://app.example.test';
const blockedOrigin = 'https://blocked.example.test';
const agentDeviceId = 'dev-test-agent-0001';
const browserId = 'browser-test-0001';
const otherBrowserId = 'browser-test-0002';

let relayProcess = null;
let relayDataDir = '';

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
}).finally(async () => {
  await stopRelay();
  cleanupRelayDataDir();
});

async function main() {
  const port = await getFreePort();
  relayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-remote-test-'));
  await startRelay(port, relayDataDir);

  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}/ws`;

  await checkHealth(baseHttp);
  await checkRejectedWebSocket(baseWs, 'bad-token', allowedOrigin, 'invalid token');
  await checkRejectedWebSocket(baseWs, token, blockedOrigin, 'blocked origin');
  await checkRejectedBrowserWithoutOrigin(baseWs);
  await checkRejectedSource(baseWs, 'relay');
  await checkRejectedLegacyAgentQuery(baseWs);
  await checkOutdatedAgentIsRejected(baseWs);

  const agent = await connectClient(baseWs, 'agent', { token, origin: allowedOrigin, userId: 'primary' });
  const browser = await connectClient(baseWs, 'browser', { token, origin: allowedOrigin, browserId, userId: 'primary' });

  try {
    await agent.sendAndWait(
      MESSAGE_TYPES.AGENT_HELLO,
      { deviceId: agentDeviceId, deviceName: 'Test Agent', agentVersion: '0.1.0' },
      (message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId
    );

    const pairingCode = await requestPairingCode(agent);

    await assertBrowserIsBlockedBeforePairing(browser, agentDeviceId);
    await assertOtherUserCannotAccessAgent(baseWs, pairingCode, agentDeviceId);
    await pairBrowser(browser, pairingCode, agentDeviceId);
    await assertBrowserCommandsReachAgent(browser, agent);
    await assertAgentUpdatesReachBrowser(agent, browser);
    await assertAgentAudioReachesBrowser(agent, browser);
    await assertBrowserTxAudioReachesAgent(browser, agent);
    await assertPairingCodeCanBeRenewed(agent);
    await assertRevokeBlocksBrowser(browser, agentDeviceId);
  } finally {
    agent.close();
    browser.close();
  }

  console.log('\nRemote Preview simulation passed.');
}

async function startRelay(port, dataDir) {
  relayProcess = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      VOXHF_RELAY_HOST: '127.0.0.1',
      VOXHF_RELAY_PORT: String(port),
      VOXHF_RELAY_USERS: `primary=${token},other=${otherToken}`,
      VOXHF_ALLOWED_ORIGINS: allowedOrigin,
      VOXHF_RELAY_REQUIRE_PAIRING: 'true',
      VOXHF_PAIRING_TTL_MS: '600000',
      VOXHF_RELAY_PERSIST_PAIRINGS: 'true',
      VOXHF_RELAY_DATA_DIR: dataDir,
      VOXHF_RELAY_PAIRINGS_FILE: path.join(dataDir, 'pairings.json'),
      VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN: 'false',
      VOXHF_RELAY_RECOMMENDED_AGENT_VERSION: '0.1.0',
      VOXHF_RELAY_MINIMUM_AGENT_VERSION: '0.1.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let relayOutput = '';
  relayProcess.stdout.on('data', (chunk) => { relayOutput += chunk.toString(); });
  relayProcess.stderr.on('data', (chunk) => { relayOutput += chunk.toString(); });

  relayProcess.on('exit', (code, signal) => {
    if (code !== null && code !== 0 && process.exitCode === undefined) {
      console.error(`[relay exited] code=${code} signal=${signal || ''}`);
      console.error(relayOutput.trim());
    }
  });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    return response && response.ok;
  }, 'relay health to become available');

  console.log(`[OK] relay started on 127.0.0.1:${port}`);
}

async function stopRelay() {
  if (!relayProcess || relayProcess.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { relayProcess.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 2000);
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

function cleanupRelayDataDir() {
  if (!relayDataDir) return;
  try {
    fs.rmSync(relayDataDir, { recursive: true, force: true });
  } catch (_) {}
}

async function checkHealth(baseHttp) {
  const response = await fetch(`${baseHttp}/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.strictEqual(response.status, 200, 'health should return HTTP 200');
  assert.strictEqual(response.headers.get('access-control-allow-origin'), allowedOrigin, 'health should include allowlisted CORS origin');
  const health = await response.json();
  assert.strictEqual(health.ok, true, 'health ok should be true');
  assert.strictEqual(health.service, 'voxhf-relay', 'health service should identify the relay');
  assert.strictEqual(health.users, 2, 'health should report configured relay users');

  const blocked = await fetch(`${baseHttp}/health`, {
    headers: { Origin: blockedOrigin },
  });
  assert.strictEqual(blocked.status, 200, 'health should still be reachable for server-side checks');
  assert.strictEqual(blocked.headers.get('access-control-allow-origin'), null, 'blocked origins should not receive CORS permission');
  console.log('[OK] health and CORS checks passed');
}

async function checkRejectedWebSocket(baseWs, candidateToken, origin, label) {
  const url = `${baseWs}?source=browser&token=${encodeURIComponent(candidateToken)}&browserId=${browserId}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket ${label} was not rejected`));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error(`WebSocket ${label} unexpectedly opened`));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      assert.ok(res.statusCode >= 400, `WebSocket ${label} should fail with HTTP error`);
      resolve();
    });
    ws.once('error', () => {});
  });
  console.log(`[OK] rejected ${label}`);
}

async function checkOutdatedAgentIsRejected(baseWs) {
  const agent = await connectClient(baseWs, 'agent', { token, origin: allowedOrigin, userId: 'primary' });
  try {
    const error = await agent.sendAndWait(
      MESSAGE_TYPES.AGENT_HELLO,
      { deviceId: 'dev-outdated-0001', deviceName: 'Outdated Agent', agentVersion: '0.0.1' },
      (message) => message.type === MESSAGE_TYPES.RELAY_ERROR && message.payload.code === 'agent-update-required'
    );
    assert.match(error.payload.message, /0\.1\.0/);
    console.log('[OK] rejected agent below minimum version');
  } finally {
    agent.close();
  }
}

async function checkRejectedBrowserWithoutOrigin(baseWs) {
  const url = `${baseWs}?source=browser&token=${encodeURIComponent(token)}&browserId=${browserId}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('WebSocket browser without Origin was not rejected'));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error('WebSocket browser without Origin unexpectedly opened'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      assert.ok(res.statusCode >= 400, 'browser without Origin should fail with HTTP error');
      resolve();
    });
    ws.once('error', () => {});
  });
  console.log('[OK] rejected browser without Origin');
}

async function checkRejectedSource(baseWs, source) {
  const url = `${baseWs}?source=${encodeURIComponent(source)}&token=${encodeURIComponent(token)}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: allowedOrigin });
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket source=${source} was not rejected`));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error(`WebSocket source=${source} unexpectedly opened`));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      assert.ok(res.statusCode >= 400, `WebSocket source=${source} should fail with HTTP error`);
      resolve();
    });
    ws.once('error', () => {});
  });
  console.log(`[OK] rejected source=${source}`);
}

async function checkRejectedLegacyAgentQuery(baseWs) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWs}?source=agent&token=${encodeURIComponent(token)}`, { origin: allowedOrigin });
    const timeout = setTimeout(() => reject(new Error('legacy agent query token was not rejected')), 1500);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error('legacy agent query token unexpectedly connected'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      assert.strictEqual(res.statusCode, 401, 'disabled agent query auth should return HTTP 401');
      resolve();
    });
    ws.once('error', () => {});
  });
  console.log('[OK] rejected legacy agent query token');
}

async function connectClient(baseWs, source, options) {
  const params = new URLSearchParams({ source });
  if (source === 'browser') params.set('token', options.token);
  if (options.browserId) params.set('browserId', options.browserId);
  const ws = new WebSocket(`${baseWs}?${params.toString()}`, {
    origin: options.origin,
    headers: source === 'agent' ? { authorization: `Bearer ${options.token}` } : undefined,
  });
  const client = new RelayClient(source, ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  const identity = await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  if (options.userId) assert.strictEqual(identity.payload.userId, options.userId, 'relay identity should match the authenticated token user');
  client.userId = identity.payload.userId;
  client.userName = identity.payload.userName || identity.payload.userId;
  console.log(`[OK] ${source} connected as ${client.userId}`);
  return client;
}

async function requestPairingCode(agent) {
  const message = await agent.sendAndWait(
    MESSAGE_TYPES.PAIRING_BEGIN,
    { deviceName: 'Test Agent' },
    (candidate) => candidate.type === MESSAGE_TYPES.PAIRING_CODE
  );
  assert.match(message.payload.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/, 'pairing code format should be readable');
  console.log('[OK] pairing code issued');
  return message.payload.code;
}

async function assertBrowserIsBlockedBeforePairing(browser, deviceId) {
  const selectError = await browser.sendAndWait(
    MESSAGE_TYPES.DEVICE_SELECT,
    { deviceId },
    (message) => message.type === MESSAGE_TYPES.RELAY_ERROR
  );
  assert.strictEqual(selectError.payload.code, 'pairing-required', 'device select should require pairing');

  const commandError = await browser.sendAndWait(
    MESSAGE_TYPES.RADIO_SET,
    { com: 1, freq: '128.350' },
    (message) => message.type === MESSAGE_TYPES.RELAY_ERROR
  );
  assert.strictEqual(commandError.payload.code, 'device-not-selected', 'commands should be blocked before selecting a paired agent');
  console.log('[OK] browser commands blocked before pairing');
}

async function pairBrowser(browser, pairingCode, deviceId) {
  const paired = await browser.sendAndWait(
    MESSAGE_TYPES.PAIRING_CONFIRM,
    { code: pairingCode },
    (message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === deviceId
  );
  assert.strictEqual(paired.payload.online, true, 'paired agent should be online');
  console.log('[OK] browser paired with agent');
}

async function assertOtherUserCannotAccessAgent(baseWs, pairingCode, deviceId) {
  const otherBrowser = await connectClient(baseWs, 'browser', {
    token: otherToken,
    origin: allowedOrigin,
    browserId: otherBrowserId,
    userId: 'other',
  });

  try {
    const pairingError = await otherBrowser.sendAndWait(
      MESSAGE_TYPES.PAIRING_CONFIRM,
      { code: pairingCode },
      (message) => message.type === MESSAGE_TYPES.RELAY_ERROR
    );
    assert.strictEqual(pairingError.payload.code, 'pairing-invalid', 'pairing codes must not cross relay users');

    const selectError = await otherBrowser.sendAndWait(
      MESSAGE_TYPES.DEVICE_SELECT,
      { deviceId },
      (message) => message.type === MESSAGE_TYPES.RELAY_ERROR
    );
    assert.strictEqual(selectError.payload.code, 'device-not-found', 'other relay users must not see this agent');
  } finally {
    otherBrowser.close();
  }

  console.log('[OK] different relay users cannot access each other');
}

async function assertBrowserCommandsReachAgent(browser, agent) {
  const commands = [
    [MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350', station: 'LIMC_TWR' }],
    [MESSAGE_TYPES.CHAT_SEND, { recipient: 'LIMC_TWR', text: 'hello remote' }],
    [MESSAGE_TYPES.WEATHER_REQUEST, { kind: 'metar', icao: 'LIMC', source: 'panel', role: 'departure' }],
    [MESSAGE_TYPES.ATIS_REQUEST, { callsign: 'LIMC_TWR' }],
    [MESSAGE_TYPES.XPDR_SET_SQUAWK, { code: '2000' }],
    [MESSAGE_TYPES.XPDR_SET_MODE, { mode: 'alt' }],
    [MESSAGE_TYPES.XPDR_IDENT, {}],
  ];

  for (const [type, payload] of commands) {
    browser.send(type, payload);
    const routed = await agent.waitFor((message) => message.type === type);
    assert.deepStrictEqual(routed.payload, payload, `${type} payload should be preserved`);
  }
  console.log('[OK] allowlisted browser commands reached agent');
}

async function assertAgentUpdatesReachBrowser(agent, browser) {
  const updates = [
    [MESSAGE_TYPES.AGENT_STATUS, {
      connected: true,
      callsign: 'MHL212',
      flightPlanStatus: 'filed',
      webTxEnabled: true,
      txReady: true,
      txSampleRate: 8000,
      squawk: '2000',
      xpdrMode: 'alt',
    }],
    [MESSAGE_TYPES.RADIO_STATE, { com1: '128.350', com2: '122.800', station1: 'LIMC_TWR', station2: 'UNICOM' }],
    [MESSAGE_TYPES.STATIONS_STATE, {
      stations: [{ callsign: 'LIMC_TWR', freq: '128.350', lat: 45.63, lon: 8.72 }],
      ownPosition: { lat: 45.50, lon: 8.80 },
    }],
    [MESSAGE_TYPES.WEATHER_STATE, {
      flightPlanStatus: 'filed',
      flightPlan: { departure: 'LIMC', destination: 'LIRF', alternate: 'LIRN' },
      weatherState: {
        departure: {
          icao: 'LIMC',
          metar: {
            text: 'LIMC 041250Z VRB02KT CAVOK 24/12 Q1015',
            receivedAt: new Date().toISOString(),
            source: '',
          },
          taf: null,
        },
        destination: {
          icao: 'LIRF',
          metar: null,
          taf: {
            text: 'LIRF 041100Z 0412/0518 25008KT CAVOK',
            receivedAt: new Date().toISOString(),
            source: '',
          },
        },
      },
    }],
    [MESSAGE_TYPES.CHAT_MESSAGE, {
      sender: 'LIMC_TWR',
      recipient: 'MHL212',
      text: 'radar contact',
      timestamp: new Date().toISOString(),
      direction: 'incoming',
    }],
  ];

  for (const [type, payload] of updates) {
    agent.send(type, payload);
    const routed = await browser.waitFor((message) => message.type === type);
    assert.deepStrictEqual(routed.payload, payload, `${type} update should reach selected browser`);
  }
  console.log('[OK] selected browser received agent updates');
}

async function assertAgentAudioReachesBrowser(agent, browser) {
  const pcm = Buffer.from([0x00, 0x00, 0x20, 0x01, 0xe0, 0xfe, 0x00, 0x00]);
  const burstCount = 420;
  for (let index = 0; index < burstCount; index += 1) {
    agent.sendBinary(pcm);
  }
  for (let index = 0; index < burstCount; index += 1) {
    const routed = await browser.waitForBinary();
    assert.deepStrictEqual(routed, pcm, 'remote RX PCM should reach the selected browser unchanged');
  }
  console.log('[OK] selected browser received remote RX audio');
}

async function assertBrowserTxAudioReachesAgent(browser, agent) {
  const pcm = Buffer.from([0x10, 0x00, 0xf0, 0xff, 0x44, 0x01, 0xbc, 0xfe]);
  const burstCount = 420;
  browser.send(MESSAGE_TYPES.TX_START, { com: 1 });

  const start = await agent.waitFor((message) => message.type === MESSAGE_TYPES.TX_START);
  assert.deepStrictEqual(start.payload, { com: 1 }, 'remote TX start should reach the selected agent');

  for (let index = 0; index < burstCount; index += 1) {
    browser.sendBinary(Buffer.concat([Buffer.from('CTX1', 'ascii'), pcm]));
  }
  for (let index = 0; index < burstCount; index += 1) {
    const routed = await agent.waitForBinary();
    assert.deepStrictEqual(routed, pcm, 'remote TX PCM should reach the selected agent without the CTX1 prefix');
  }

  browser.send(MESSAGE_TYPES.TX_STOP);
  const stop = await agent.waitFor((message) => message.type === MESSAGE_TYPES.TX_STOP);
  assert.deepStrictEqual(stop.payload, {}, 'remote TX stop should reach the selected agent');
  console.log('[OK] selected agent received remote TX audio');
}

async function assertPairingCodeCanBeRenewed(agent) {
  agent.send(MESSAGE_TYPES.PAIRING_BEGIN, { deviceName: 'Test Agent' });
  const renewed = await agent.waitFor((message) => message.type === MESSAGE_TYPES.PAIRING_CODE);
  assert.match(renewed.payload.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/, 'renewed pairing code should use the expected format');
  assert.ok(Date.parse(renewed.payload.expiresAt), 'renewed pairing code should include an expiry timestamp');
  console.log('[OK] pairing code can be renewed without restarting the agent');
}

async function assertRevokeBlocksBrowser(browser, deviceId) {
  const revoked = await browser.sendAndWait(
    MESSAGE_TYPES.PAIRING_REVOKE,
    { deviceId },
    (message) => message.type === MESSAGE_TYPES.PAIRING_REVOKED
  );
  assert.strictEqual(revoked.payload.deviceId, deviceId, 'revoked device id should match');

  const commandError = await browser.sendAndWait(
    MESSAGE_TYPES.CHAT_SEND,
    { recipient: 'LIMC_TWR', text: 'after revoke' },
    (message) => message.type === MESSAGE_TYPES.RELAY_ERROR
  );
  assert.strictEqual(commandError.payload.code, 'device-not-selected', 'revoked browser should no longer have a selected agent');
  console.log('[OK] revoked browser cannot command agent');
}

class RelayClient {
  constructor(name, ws) {
    this.name = name;
    this.ws = ws;
    this.queue = [];
    this.binaryQueue = [];
    this.waiters = [];
    this.binaryWaiters = [];
    this.closed = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.handleBinary(Buffer.from(data));
        return;
      }
      const message = JSON.parse(data.toString('utf8'));
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });

    ws.on('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name} socket closed while waiting for message`));
      }
      while (this.binaryWaiters.length) {
        const waiter = this.binaryWaiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name} socket closed while waiting for binary relay frame`));
      }
    });
  }

  handleBinary(frame) {
    const waiter = this.binaryWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.binaryQueue.push(frame);
  }

  open() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${this.name} WebSocket open timed out`)), 2000);
      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify(createRemoteMessage(type, payload, `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)));
  }

  sendBinary(frame) {
    this.ws.send(frame, { binary: true });
  }

  sendAndWait(type, payload, predicate) {
    this.send(type, payload);
    return this.waitFor(predicate);
  }

  waitFor(predicate, timeoutMs = 2500) {
    const existingIndex = this.queue.findIndex(predicate);
    if (existingIndex >= 0) {
      const [message] = this.queue.splice(existingIndex, 1);
      return Promise.resolve(message);
    }
    if (this.closed) return Promise.reject(new Error(`${this.name} socket is closed`));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.name} timed out waiting for relay message`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForBinary(timeoutMs = 2500) {
    if (this.binaryQueue.length) return Promise.resolve(this.binaryQueue.shift());
    if (this.closed) return Promise.reject(new Error(`${this.name} socket is closed`));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.binaryWaiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.binaryWaiters.splice(index, 1);
        reject(new Error(`${this.name} timed out waiting for binary relay frame`));
      }, timeoutMs);
      this.binaryWaiters.push({ resolve, reject, timer });
    });
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }
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
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
