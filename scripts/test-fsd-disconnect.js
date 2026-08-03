'use strict';

// Covers confirmed versus incomplete FSD sessions and the fresh two-sample,
// five-knot policy used to suppress intentional stationary disconnect alerts.
const assert = require('assert');
const net = require('net');
const { createFsdProxy } = require('../proxy/fsd-proxy');
const { createAppState, disconnectAlertSuppressionReason } = require('../proxy/app-state');
const { parseFsdLine } = require('../proxy/fsd-parser');

const logger = { log() {}, error() {} };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function waitFor(predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(check, 10);
    };
    check();
  });
}

function stateStub() {
  let connected = false;
  return {
    broadcast() {},
    getCallsign: () => 'WZZ2807',
    getConnected: () => connected,
    rememberFsdState() {},
    setConnected(value) { connected = Boolean(value); },
  };
}

function proxyOptions(remotePort, events) {
  return {
    port: remotePort,
    state: stateStub(),
    logger,
    timestamp: () => new Date().toISOString(),
    getHost: () => '127.0.0.1',
    getLanIp: () => '127.0.0.1',
    onVoiceServer() {},
    onConnected: () => events.push({ type: 'connected' }),
    onClose: meta => events.push({ type: 'closed', ...meta }),
  };
}

async function testConfirmedDisconnect() {
  let upstreamSocket = null;
  const upstream = net.createServer(socket => { upstreamSocket = socket; });
  const remotePort = await listen(upstream);
  const events = [];
  const proxy = createFsdProxy(proxyOptions(remotePort, events));
  const proxyPort = await listen(proxy.server);
  const core = net.createConnection({ host: '127.0.0.1', port: proxyPort });
  core.on('error', () => {});

  try {
    await waitFor(() => upstreamSocket && events.some(event => event.type === 'connected'), 'confirmed IVAO connection');
    upstreamSocket.destroy();
    await waitFor(() => events.some(event => event.type === 'closed'), 'confirmed IVAO close');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.filter(event => event.type === 'connected').length, 1);
    assert.deepEqual(events.filter(event => event.type === 'closed'), [
      { type: 'closed', wasConnected: true },
    ]);
  } finally {
    core.destroy();
    upstreamSocket?.destroy();
    await closeServer(proxy.server);
    await closeServer(upstream);
  }
}

async function testUnconfirmedDisconnect() {
  const reservation = net.createServer();
  const unavailablePort = await listen(reservation);
  await closeServer(reservation);

  const events = [];
  const proxy = createFsdProxy(proxyOptions(unavailablePort, events));
  const proxyPort = await listen(proxy.server);
  const core = net.createConnection({ host: '127.0.0.1', port: proxyPort });
  core.on('error', () => {});

  try {
    await waitFor(() => events.some(event => event.type === 'closed'), 'failed IVAO connection close');
    assert.equal(events.some(event => event.type === 'connected'), false);
    assert.deepEqual(events.filter(event => event.type === 'closed'), [
      { type: 'closed', wasConnected: false },
    ]);
  } finally {
    core.destroy();
    await closeServer(proxy.server);
  }
}

function testDisconnectAlertPolicy() {
  const parsed = parseFsdLine('@N:WZZ2807:7000:1:45.50000:8.80000:16000:420:0:0', 'outgoing');
  assert.equal(parsed.kind, 'own_position');
  assert.equal(parsed.groundSpeed, 420);

  const observedAt = '2026-08-01T12:00:00.000Z';
  const now = Date.parse(observedAt) + 5_000;
  const state = createAppState({ timestamp: () => observedAt, publish() {} });
  const remember = (groundSpeed) => state.rememberFsdState({
    kind: 'own_position',
    lat: 45.5,
    lon: 8.8,
    groundSpeed,
    timestamp: observedAt,
  });

  remember(5);
  assert.equal(disconnectAlertSuppressionReason(state.getFlightTelemetry(), now), '');
  remember(5);
  assert.equal(
    disconnectAlertSuppressionReason(state.getFlightTelemetry(), now),
    'aircraft stationary at 5 kt',
  );

  state.resetFlightTelemetry();
  remember(6);
  remember(6);
  assert.equal(disconnectAlertSuppressionReason(state.getFlightTelemetry(), now), '');

  state.resetFlightTelemetry();
  remember(0);
  remember(0);
  assert.equal(
    disconnectAlertSuppressionReason(state.getFlightTelemetry(), now),
    'aircraft stationary at 0 kt',
  );
  assert.equal(
    disconnectAlertSuppressionReason(state.getFlightTelemetry(), now + 20_001),
    '',
  );
}

(async () => {
  await testConfirmedDisconnect();
  await testUnconfirmedDisconnect();
  testDisconnectAlertPolicy();
  console.log('[OK] FSD disconnect notification policy');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
