'use strict';

// Relay admin API smoke test.
//
// This starts real relay processes and exercises the protected admin API that
// backs /admin. It verifies owner bootstrap/login/session flows, break-glass
// recovery, env-mode behavior, and the SQLite relay-user lifecycle.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const relayDb = require('../apps/relay/db');
const adminMfa = require('../apps/relay/admin-mfa');
const {
  MESSAGE_TYPES,
  createRemoteMessage,
} = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const allowedOrigin = 'https://app.example.test';
const adminToken = 'admin-token-00000000000000000000000000000000';
const ownerPassword = 'correct-horse-battery-owner';
const changedOwnerPassword = 'correct-horse-battery-changed';

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
});

async function main() {
  await assertAdminDisabledInEnvMode();
  await assertAdminSqliteUserLifecycle();
  console.log('[OK] relay admin API');
}

async function assertAdminDisabledInEnvMode() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-admin-env-'));
  let relay = null;

  try {
    const port = await getFreePort();
    relay = await startRelay({
      port,
      dataDir: tempDir,
      authMode: 'env',
      envUsers: 'default=default-token-000000000000000000000000000000',
      dbFile: path.join(tempDir, 'voxhf.db'),
    });

    const html = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.strictEqual(html.status, 200, 'admin html should be served');
    const authStatus = await fetchJson(port, '/admin/api/auth/status', { auth: false });
    assert.strictEqual(authStatus.status, 200, 'admin auth status should be public');
    assert.strictEqual(authStatus.body.accountLoginAvailable, false, 'env mode should not offer admin accounts');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const unauthorized = await fetchJson(port, '/admin/api/status', { token: 'wrong-token' });
      assert.strictEqual(unauthorized.status, 401, 'bad admin token should be rejected');
    }
    const rateLimited = await fetchJson(port, '/admin/api/status', { token: 'wrong-token' });
    assert.strictEqual(rateLimited.status, 429, 'repeated bad admin tokens should be rate-limited');
    assert.strictEqual(rateLimited.body.code, 'auth_rate_limited', 'admin rate limit should use a stable code');

    await delay(1100);

    const status = await fetchJson(port, '/admin/api/status');
    assert.strictEqual(status.status, 200, 'admin status should work in env mode');
    assert.strictEqual(status.body.sqliteAdmin, false, 'sqlite admin should be disabled in env mode');

    const users = await fetchJson(port, '/admin/api/users');
    assert.strictEqual(users.status, 409, 'sqlite user list should be blocked in env mode');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAdminSqliteUserLifecycle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-admin-sqlite-'));
  let relay = null;

  try {
    const dbFile = path.join(tempDir, 'voxhf.db');
    const port = await getFreePort();
    relay = await startRelay({
      port,
      dataDir: tempDir,
      authMode: 'sqlite-fallback',
      envUsers: 'bootstrap=bootstrap-token-00000000000000000000000000',
      dbFile,
    });

    await assertAdminAccountLifecycle(port, dbFile);

    const created = await fetchJson(port, '/admin/api/users', {
      method: 'POST',
      body: { userId: 'alice', displayName: 'Alice' },
    });
    assert.strictEqual(created.status, 201, 'admin create should return created');
    assert.ok(created.body.token, 'admin create should return one-time token');
    await assertConnectsAs(port, created.body.token, 'alice');

    const listed = await fetchJson(port, '/admin/api/users');
    assert.strictEqual(listed.status, 200, 'admin list should work');
    assert.ok(listed.body.users.some((user) => user.userId === 'alice'), 'created user should be listed');
    await assertAuditContains(port, 'admin.user_created');
    await assertAdminDeviceAndPairingViews(port, created.body.token);

    const rotated = await fetchJson(port, '/admin/api/users/alice/rotate', { method: 'POST' });
    assert.strictEqual(rotated.status, 200, 'admin rotate should work');
    assert.notStrictEqual(rotated.body.token, created.body.token, 'rotation should return a new token');
    await assertRejected(port, created.body.token);
    await assertConnectsAs(port, rotated.body.token, 'alice');

    const revoked = await fetchJson(port, '/admin/api/users/alice/revoke', { method: 'POST' });
    assert.strictEqual(revoked.status, 200, 'admin revoke should work');
    await assertAuditContains(port, 'admin.tokens_revoked');
    await assertRejected(port, rotated.body.token);

    const bob = await fetchJson(port, '/admin/api/users', {
      method: 'POST',
      body: { userId: 'bob', displayName: 'Bob' },
    });
    assert.strictEqual(bob.status, 201, 'second user should be created');
    await assertConnectsAs(port, bob.body.token, 'bob');

    const disabled = await fetchJson(port, '/admin/api/users/bob/disable', { method: 'POST' });
    assert.strictEqual(disabled.status, 200, 'admin disable should work');
    await assertRejected(port, bob.body.token);

    const enabled = await fetchJson(port, '/admin/api/users/bob/enable', { method: 'POST' });
    assert.strictEqual(enabled.status, 200, 'admin enable should work');
    await assertConnectsAs(port, bob.body.token, 'bob');

    const deleted = await fetchJson(port, '/admin/api/users/bob/delete', { method: 'POST' });
    assert.strictEqual(deleted.status, 200, 'admin delete should work');
    await assertAuditContains(port, 'admin.user_deleted');
    await assertRejected(port, bob.body.token);

    const afterDelete = await fetchJson(port, '/admin/api/users');
    assert.strictEqual(afterDelete.status, 200, 'admin list should work after delete');
    assert.ok(!afterDelete.body.users.some((user) => user.userId === 'bob'), 'deleted user should not be listed');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAdminAccountLifecycle(port, dbFile) {
  const initial = await fetchJson(port, '/admin/api/auth/status', { auth: false });
  assert.strictEqual(initial.status, 200, 'admin auth status should work before bootstrap');
  assert.strictEqual(initial.body.bootstrapRequired, true, 'empty admin database should require bootstrap');

  const bootstrap = await fetchJson(port, '/admin/api/auth/bootstrap', {
    method: 'POST',
    body: { username: 'owner', displayName: 'Relay Owner', password: ownerPassword },
  });
  assert.strictEqual(bootstrap.status, 201, 'break-glass token should bootstrap the owner');
  assert.match(bootstrap.setCookie, /voxhf_admin=/, 'bootstrap should set an admin cookie');
  assert.match(bootstrap.setCookie, /HttpOnly/i, 'admin cookie should be HttpOnly');
  assert.match(bootstrap.setCookie, /SameSite=Strict/i, 'admin cookie should be SameSite Strict');
  assert.match(bootstrap.setCookie, /Path=\/admin/i, 'admin cookie should be scoped to /admin');
  const firstCookie = cookiePair(bootstrap.setCookie);

  const duplicate = await fetchJson(port, '/admin/api/auth/bootstrap', {
    method: 'POST',
    body: { username: 'second', displayName: 'Second Owner', password: ownerPassword },
  });
  assert.strictEqual(duplicate.status, 409, 'bootstrap must be one-time');

  const protectedStatus = await fetchJson(port, '/admin/api/status', { auth: false, cookie: firstCookie });
  assert.strictEqual(protectedStatus.status, 200, 'admin session should authorize protected APIs');
  assert.strictEqual(protectedStatus.body.admin.username, 'owner', 'protected status should expose the current owner');

  const login = await fetchJson(port, '/admin/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: 'owner', password: ownerPassword },
  });
  assert.strictEqual(login.status, 200, 'owner should log in with password');
  const secondCookie = cookiePair(login.setCookie);

  const sessions = await fetchJson(port, '/admin/api/sessions', { auth: false, cookie: secondCookie });
  assert.strictEqual(sessions.status, 200, 'owner should list admin sessions');
  assert.strictEqual(sessions.body.sessions.length, 2, 'bootstrap and login should create two sessions');

  const passwordChange = await fetchJson(port, '/admin/api/auth/password', {
    method: 'POST',
    auth: false,
    cookie: secondCookie,
    body: { currentPassword: ownerPassword, newPassword: changedOwnerPassword },
  });
  assert.strictEqual(passwordChange.status, 200, 'owner should change the password');
  assert.strictEqual(passwordChange.body.revokedSessions, 1, 'password change should revoke other sessions');

  const revokedFirst = await fetchJson(port, '/admin/api/status', { auth: false, cookie: firstCookie });
  assert.strictEqual(revokedFirst.status, 401, 'revoked admin session should stop authorizing APIs');

  const oldPassword = await fetchJson(port, '/admin/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: 'owner', password: ownerPassword },
  });
  assert.strictEqual(oldPassword.status, 401, 'old owner password should stop working');

  const newPassword = await fetchJson(port, '/admin/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: 'owner', password: changedOwnerPassword },
  });
  assert.strictEqual(newPassword.status, 200, 'new owner password should work');
  const thirdCookie = cookiePair(newPassword.setCookie);

  const recovered = await fetchJson(port, '/admin/api/auth/recover', {
    method: 'POST',
    body: { username: 'owner', newPassword: ownerPassword },
  });
  assert.strictEqual(recovered.status, 200, 'break-glass token should recover the owner');
  let recoveredCookie = cookiePair(recovered.setCookie);

  const revokedByRecovery = await fetchJson(port, '/admin/api/status', { auth: false, cookie: thirdCookie });
  assert.strictEqual(revokedByRecovery.status, 401, 'recovery should revoke existing sessions');
  const recoveredStatus = await fetchJson(port, '/admin/api/status', { auth: false, cookie: recoveredCookie });
  assert.strictEqual(recoveredStatus.status, 200, 'recovery should issue a fresh session');

  recoveredCookie = await assertOptionalMfaRecoveryLogin(port, dbFile, recoveredCookie);

  const logout = await fetchJson(port, '/admin/api/auth/logout', {
    method: 'POST',
    auth: false,
    cookie: recoveredCookie,
    body: {},
  });
  assert.strictEqual(logout.status, 200, 'owner should log out');
  assert.match(logout.setCookie, /Max-Age=0/i, 'logout should clear the admin cookie');
}

async function assertOptionalMfaRecoveryLogin(port, dbFile, currentCookie) {
  const recoveryCode = 'ABCDE-FGHJK-MNPQR';
  const db = relayDb.openRelayDatabase({ filename: dbFile });
  try {
    const account = relayDb.getAdminAccountCredentials(db, 'owner');
    relayDb.createAdminPasskey(db, {
      adminId: account.adminId,
      credentialId: 'ZmFrZS1hZG1pbi1wYXNza2V5',
      name: 'Test passkey',
      webauthnUserId: adminMfa.webAuthnUserId(account.adminId),
      publicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
    });
    relayDb.replaceAdminRecoveryCodes(db, account.adminId, [
      adminMfa.hashRecoveryCode(account.adminId, recoveryCode),
    ]);
  } finally {
    db.close();
  }

  const status = await fetchJson(port, '/admin/api/mfa', { auth: false, cookie: currentCookie });
  assert.strictEqual(status.status, 200, 'MFA status should be available to the owner');
  assert.strictEqual(status.body.enabled, true, 'a stored passkey should opt the owner into MFA');

  const passwordStep = await fetchJson(port, '/admin/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: 'owner', password: ownerPassword },
  });
  assert.strictEqual(passwordStep.status, 200, 'valid password should begin optional MFA login');
  assert.strictEqual(passwordStep.body.mfaRequired, true, 'MFA-enabled owner should receive a challenge');
  assert.strictEqual(passwordStep.setCookie, '', 'password step must not create an admin session');

  const recoveryStep = await fetchJson(port, '/admin/api/auth/mfa/recovery', {
    method: 'POST',
    auth: false,
    body: { flowToken: passwordStep.body.flowToken, recoveryCode },
  });
  assert.strictEqual(recoveryStep.status, 200, 'a recovery code should complete MFA login');
  const mfaCookie = cookiePair(recoveryStep.setCookie);
  const protectedStatus = await fetchJson(port, '/admin/api/status', { auth: false, cookie: mfaCookie });
  assert.strictEqual(protectedStatus.status, 200, 'MFA login should issue an admin session');

  const recovered = await fetchJson(port, '/admin/api/auth/recover', {
    method: 'POST',
    body: { username: 'owner', newPassword: ownerPassword },
  });
  assert.strictEqual(recovered.status, 200, 'break-glass recovery should remain available with MFA enabled');
  const recoveredCookie = cookiePair(recovered.setCookie);
  const mfaAfterRecovery = await fetchJson(port, '/admin/api/mfa', { auth: false, cookie: recoveredCookie });
  assert.strictEqual(mfaAfterRecovery.body.enabled, false, 'break-glass recovery should clear optional MFA');
  return recoveredCookie;
}

async function assertAdminDeviceAndPairingViews(port, token) {
  const baseWs = `ws://127.0.0.1:${port}/ws`;
  const agent = await connectRelayClient(baseWs, 'agent', { token });
  const browser = await connectRelayClient(baseWs, 'browser', { token, browserId: 'browser-alice-admin' });

  try {
    agent.send(MESSAGE_TYPES.AGENT_HELLO, { deviceId: 'device-alice-admin', deviceName: 'Alice Admin PC' });
    await agent.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === 'device-alice-admin');

    agent.send(MESSAGE_TYPES.PAIRING_BEGIN, { deviceName: 'Alice Admin PC' });
    const code = await agent.waitFor((message) => message.type === MESSAGE_TYPES.PAIRING_CODE);

    browser.send(MESSAGE_TYPES.PAIRING_CONFIRM, { code: code.payload.code });
    await browser.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === 'device-alice-admin');

    const devices = await fetchJson(port, '/admin/api/devices');
    assert.strictEqual(devices.status, 200, 'admin devices should be listed');
    assert.ok(
      devices.body.devices.some((device) => device.userId === 'alice' && device.deviceId === 'device-alice-admin' && device.online),
      'paired online agent should be visible in admin devices'
    );

    const pairings = await fetchJson(port, '/admin/api/pairings');
    assert.strictEqual(pairings.status, 200, 'admin pairings should be listed');
    const pairing = pairings.body.pairings.find((item) => item.userId === 'alice' && item.deviceId === 'device-alice-admin');
    assert.ok(pairing, 'active browser pairing should be visible in admin pairings');

    const revoked = await fetchJson(port, `/admin/api/pairings/${encodeURIComponent(pairing.pairingId)}/revoke`, { method: 'POST' });
    assert.strictEqual(revoked.status, 200, 'admin pairing revoke should work');
    await assertAuditContains(port, 'pairing.created');
    await assertAuditContains(port, 'pairing.revoked_admin');
    await browser.waitFor((message) => message.type === MESSAGE_TYPES.PAIRING_REVOKED);

    browser.send(MESSAGE_TYPES.DEVICE_SELECT, { deviceId: 'device-alice-admin' });
    const blocked = await browser.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_ERROR);
    assert.strictEqual(blocked.payload.code, 'pairing-required', 'revoked browser should lose device access');
  } finally {
    agent.close();
    browser.close();
  }
}

async function assertAuditContains(port, eventType) {
  const audit = await fetchJson(port, '/admin/api/audit');
  assert.strictEqual(audit.status, 200, 'admin audit list should work');
  assert.ok(
    audit.body.events.some((event) => event.eventType === eventType),
    `audit should contain ${eventType}`
  );
}

async function fetchJson(port, pathName, options = {}) {
  const headers = { 'content-type': 'application/json', origin: allowedOrigin };
  if (options.auth !== false) headers.authorization = `Bearer ${options.token || adminToken}`;
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, setCookie: response.headers.get('set-cookie') || '' };
}

function cookiePair(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function startRelay(options) {
  const relayProcess = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      VOXHF_RELAY_HOST: '127.0.0.1',
      VOXHF_RELAY_PORT: String(options.port),
      VOXHF_RELAY_AUTH_MODE: options.authMode,
      VOXHF_RELAY_ADMIN_TOKEN: adminToken,
      VOXHF_RELAY_RATE_WINDOW_MS: '1000',
      VOXHF_RELAY_MAX_ADMIN_ATTEMPTS_PER_WINDOW: '3',
      VOXHF_RELAY_DATABASE: options.dbFile,
      VOXHF_RELAY_USERS: options.envUsers || '',
      VOXHF_RELAY_TOKEN: '',
      VOXHF_ALLOWED_ORIGINS: allowedOrigin,
      VOXHF_RELAY_REQUIRE_PAIRING: 'true',
      VOXHF_RELAY_PERSIST_AUDIT: 'true',
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

async function assertConnectsAs(port, token, userId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?source=browser&token=${encodeURIComponent(token)}&browserId=browser-${userId}`, {
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

async function connectRelayClient(baseWs, source, options) {
  const params = new URLSearchParams({ source });
  if (source === 'browser') params.set('token', options.token);
  if (options.browserId) params.set('browserId', options.browserId);

  const ws = new WebSocket(`${baseWs}?${params.toString()}`, {
    origin: allowedOrigin,
    headers: source === 'agent' ? { authorization: `Bearer ${options.token}` } : undefined,
  });
  const client = new RelayClient(source, ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  return client;
}

async function assertRejected(port, token) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?source=browser&token=${encodeURIComponent(token)}&browserId=browser-bad`, {
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

class RelayClient {
  constructor(name, ws) {
    this.name = name;
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.closed = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString('utf8'));
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.queue.push(message);
    });

    ws.on('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name} socket closed while waiting for message`));
      }
    });
  }

  open() {
    return onceOpen(this.ws);
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify(createRemoteMessage(type, payload, `${this.name}-${Date.now().toString(36)}`)));
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

  close() {
    try { this.ws.close(); } catch (_) {}
  }
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
