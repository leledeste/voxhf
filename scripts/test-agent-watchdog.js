'use strict';

// Exercises staging, atomic replacement, reconnect cancellation, endpoint
// restrictions, one-use delivery, expiry, and successful-delivery receipts.
const assert = require('assert');
const {
  createAgentWatchdog,
  isAllowedPushEndpoint,
  sendSealedPushTicket,
} = require('../apps/relay/agent-watchdog');

const DEVICE_KEY = 'user-one\ndevice-one';
const SESSION_ID = 'flight-session-12345678';
const BATCH_ID = 'watchdog-batch-12345678';

function ticket(deviceId, overrides = {}) {
  return {
    deviceId,
    endpoint: `https://push.example/${deviceId}`,
    expiresAt: '2026-08-02T12:15:00.000Z',
    authorization: 'vapid signed-proxy-request-123456789',
    contentEncoding: 'aes128gcm',
    body: Buffer.from(`encrypted-${deviceId}`).toString('base64url'),
    ...overrides,
  };
}

(async () => {
  let clock = Date.parse('2026-08-02T12:00:00.000Z');
  let nextTimerId = 0;
  const timers = new Map();
  const sent = [];
  const fired = [];
  const watchdog = createAgentWatchdog({
    now: () => clock,
    offlineDelayMs: 30_000,
    allowedPushOrigins: ['https://push.example'],
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async sendTicket(value) {
      sent.push(value);
      return { sent: true, status: 201 };
    },
    onFired: event => fired.push(event),
    logger: { log() {}, warn() {} },
  });

  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/Q123'), true);
  assert.equal(isAllowedPushEndpoint('https://wns2-am3p.notify.windows.com/w/?token=1'), true);
  assert.equal(isAllowedPushEndpoint('https://127.0.0.1/push'), false);
  assert.equal(isAllowedPushEndpoint('https://push.example/device', ['https://push.example']), true);

  const stagedOne = watchdog.stage(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: BATCH_ID,
    ticket: ticket('browser-one-12345678'),
  });
  const stagedTwo = watchdog.stage(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: BATCH_ID,
    ticket: ticket('browser-two-12345678'),
  });
  assert.deepEqual(stagedOne, { ok: true, ticketCount: 1 });
  assert.deepEqual(stagedTwo, { ok: true, ticketCount: 2 });
  assert.deepEqual(watchdog.commit(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: BATCH_ID,
  }), { ok: true, ticketCount: 2 });
  assert.deepEqual(watchdog.getState(DEVICE_KEY), {
    armed: true,
    sessionId: SESSION_ID,
    ticketCount: 2,
    offlinePending: false,
  });

  assert.equal(watchdog.agentOffline(DEVICE_KEY), true);
  assert.equal(Array.from(timers.values())[0].delay, 30_000);
  watchdog.agentOnline(DEVICE_KEY);
  assert.equal(timers.size, 0, 'reconnect inside the grace period must cancel delivery');
  assert.equal(sent.length, 0);

  assert.equal(watchdog.agentOffline(DEVICE_KEY), true);
  const expiryTimer = Array.from(timers.values())[0];
  clock += 30_000;
  await expiryTimer.callback();
  assert.equal(sent.length, 2);
  assert.equal(fired.length, 1);
  assert.deepEqual(watchdog.getState(DEVICE_KEY), { armed: false });
  assert.deepEqual(watchdog.disarm(DEVICE_KEY, SESSION_ID), { ok: true, fired: true });
  assert.deepEqual(watchdog.disarm(DEVICE_KEY, SESSION_ID), { ok: true, fired: false });

  let failedTimerCallback = null;
  const failedWatchdog = createAgentWatchdog({
    now: () => clock,
    offlineDelayMs: 30_000,
    allowedPushOrigins: ['https://push.example'],
    setTimer(callback) {
      failedTimerCallback = callback;
      return callback;
    },
    clearTimer() {},
    async sendTicket() {
      return { sent: false, status: 503 };
    },
    logger: { log() {}, warn() {} },
  });
  const failedSessionId = 'flight-session-failed-12345678';
  const failedBatchId = 'watchdog-batch-failed-12345678';
  assert.equal(failedWatchdog.stage(DEVICE_KEY, {
    sessionId: failedSessionId,
    batchId: failedBatchId,
    ticket: ticket('browser-failed-12345678'),
  }).ok, true);
  assert.equal(failedWatchdog.commit(DEVICE_KEY, {
    sessionId: failedSessionId,
    batchId: failedBatchId,
  }).ok, true);
  assert.equal(failedWatchdog.agentOffline(DEVICE_KEY), true);
  assert.equal(failedWatchdog.agentOffline(DEVICE_KEY), false, 'only one offline timer may be active');
  clock += 30_000;
  await failedTimerCallback();
  assert.deepEqual(
    failedWatchdog.disarm(DEVICE_KEY, failedSessionId),
    { ok: true, fired: false },
    'a failed relay delivery must not suppress the local disconnect retry',
  );
  failedWatchdog.dispose();

  let pendingTimerCallback = null;
  let resolvePendingDelivery;
  const pendingEvents = [];
  const pendingWatchdog = createAgentWatchdog({
    now: () => clock,
    offlineDelayMs: 30_000,
    allowedPushOrigins: ['https://push.example'],
    setTimer(callback) { pendingTimerCallback = callback; return callback; },
    clearTimer() {},
    sendTicket() {
      return new Promise(resolve => { resolvePendingDelivery = resolve; });
    },
    onFired(event) { pendingEvents.push(event); return true; },
    logger: { log() {}, warn() {} },
  });
  const pendingSessionId = 'flight-session-pending-12345678';
  const pendingBatchId = 'watchdog-batch-delivery-12345678';
  pendingWatchdog.stage(DEVICE_KEY, {
    sessionId: pendingSessionId,
    batchId: pendingBatchId,
    ticket: ticket('browser-delivery-pending-12345678'),
  });
  pendingWatchdog.commit(DEVICE_KEY, { sessionId: pendingSessionId, batchId: pendingBatchId });
  pendingWatchdog.agentOffline(DEVICE_KEY);
  const pendingFire = pendingTimerCallback();
  assert.deepEqual(pendingWatchdog.disarm(DEVICE_KEY, pendingSessionId), { ok: true, fired: false });
  resolvePendingDelivery({ sent: true, status: 201 });
  await pendingFire;
  assert.equal(pendingEvents.length, 1, 'a late successful delivery must notify a reconnected agent');
  assert.deepEqual(pendingWatchdog.disarm(DEVICE_KEY, pendingSessionId), { ok: true, fired: false });
  pendingWatchdog.dispose();

  const blocked = watchdog.stage(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: 'watchdog-batch-blocked',
    ticket: ticket('browser-bad-12345678', { endpoint: 'https://127.0.0.1/internal' }),
  });
  assert.equal(blocked.ok, false);

  const boundedWatchdog = createAgentWatchdog({
    now: () => clock,
    offlineDelayMs: 30_000,
    maxBatchesPerDevice: 2,
    allowedPushOrigins: ['https://push.example'],
    logger: { log() {}, warn() {} },
  });
  for (const suffix of ['one', 'two']) {
    assert.equal(boundedWatchdog.stage(DEVICE_KEY, {
      sessionId: SESSION_ID,
      batchId: `watchdog-pending-${suffix}`,
      ticket: ticket(`browser-pending-${suffix}-12345678`),
    }).ok, true);
  }
  assert.equal(boundedWatchdog.stage(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: 'watchdog-pending-three',
    ticket: ticket('browser-pending-three-12345678'),
  }).ok, false, 'pending batches must be bounded per agent');
  boundedWatchdog.dispose();

  const expiring = watchdog.stage(DEVICE_KEY, {
    sessionId: SESSION_ID,
    batchId: 'watchdog-batch-expired',
    ticket: ticket('browser-old-12345678', { expiresAt: new Date(clock + 10_000).toISOString() }),
  });
  assert.equal(expiring.ok, false);

  const fetchCalls = [];
  const sealed = ticket('browser-send-12345678');
  const delivery = await sendSealedPushTicket(sealed, {
    allowedPushOrigins: ['https://push.example'],
    abortSignal: null,
    async fetchImpl(endpoint, options) {
      fetchCalls.push({ endpoint, options });
      return { status: 201 };
    },
  });
  assert.deepEqual(delivery, { sent: true, expired: false, status: 201 });
  assert.equal(fetchCalls[0].endpoint, sealed.endpoint);
  assert.equal(fetchCalls[0].options.redirect, 'error');
  assert.equal(fetchCalls[0].options.headers.Authorization, sealed.authorization);
  assert.equal(fetchCalls[0].options.headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(fetchCalls[0].options.body, Buffer.from(sealed.body, 'base64url'));

  watchdog.dispose();
  console.log('[OK] relay agent-offline watchdog behavior');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
