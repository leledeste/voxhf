'use strict';

// Relay account API smoke test.
//
// This starts a real relay with SQLite auth and invite-only registration,
// then verifies the intended private hosted-account flow: registration creates an
// agent token, the agent connects with that token, and a logged-in browser can
// open a WebSocket with only its HttpOnly session cookie.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const LEGAL = require('../apps/relay/legal');
const {
  MESSAGE_TYPES,
  createRemoteMessage,
} = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const allowedOrigin = 'https://app.example.test';
const agentDeviceId = 'device-account-test';
const browserId = 'browser-account-test';
const adminToken = 'account-admin-token-000000000000000000000000';

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-relay-account-'));
  let relay = null;

  try {
    const port = await getFreePort();
    const dbFile = path.join(tempDir, 'voxhf.db');
    relay = await startRelay({ port, dataDir: tempDir, dbFile });

    const status = await fetchJson(port, '/account/api/status');
    assert.strictEqual(status.status, 200, 'account status should be available');
    assert.deepStrictEqual(status.body.legal, LEGAL, 'account status should publish the current legal versions');

    const blockedOrigin = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      origin: 'https://evil.example.test',
      body: { userId: 'blocked_origin', password: 'correct horse battery staple' },
    });
    assert.strictEqual(blockedOrigin.status, 403, 'an untrusted browser origin should be rejected');
    assert.strictEqual(blockedOrigin.body.code, 'forbidden_origin', 'origin rejection should use a stable code');

    const formPost = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      contentType: 'text/plain',
      rawBody: '{}',
    });
    assert.strictEqual(formPost.status, 415, 'non-JSON account POST should be rejected');
    assert.strictEqual(formPost.body.code, 'unsupported_media_type', 'content-type rejection should use a stable code');

    const blocked = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: {
        userId: 'account_user',
        displayName: 'Account User',
        password: 'correct horse battery staple',
      },
    });
    assert.strictEqual(blocked.status, 403, 'registration without an invite should be rejected');
    assert.strictEqual(blocked.body.code, 'invalid_invite', 'missing invite should return a stable code');

    const invite = await createInvite(port);
    const missingAcceptance = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: {
        userId: 'account_user',
        displayName: 'Account User',
        password: 'correct horse battery staple',
        inviteCode: invite,
      },
    });
    assert.strictEqual(missingAcceptance.status, 400, 'registration should require legal acceptance');
    assert.strictEqual(missingAcceptance.body.code, 'legal_acceptance_required', 'legal rejection should use a stable code');

    const registered = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: acceptedRegistration({
        userId: 'account_user',
        displayName: 'Account User',
        password: 'correct horse battery staple',
        inviteCode: invite,
      }),
      secureProxy: true,
    });
    assert.strictEqual(registered.status, 201, 'registration should create an account');
    assert.ok(registered.body.agentToken, 'registration should return one-time agent token');
    assert.ok(registered.cookie, 'registration should set a browser session cookie');
    assert.match(registered.setCookie, /; HttpOnly/i, 'session cookie should be HttpOnly');
    assert.match(registered.setCookie, /; SameSite=Lax/i, 'session cookie should be SameSite=Lax');
    assert.match(registered.setCookie, /; Secure/i, 'HTTPS proxy requests should receive a Secure cookie');
    assertPrivacyDefaults(dbFile);
    let accountCookie = registered.cookie;

    const reused = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: {
        userId: 'another_user',
        displayName: 'Another User',
        password: 'another correct horse battery staple',
        inviteCode: invite,
      },
    });
    assert.strictEqual(reused.status, 403, 'an invite should be usable only once');

    const duplicate = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: acceptedRegistration({
        userId: 'account_user',
        displayName: 'Duplicate',
        password: 'another correct horse battery staple',
        inviteCode: await createInvite(port),
      }),
    });
    assert.strictEqual(duplicate.status, 409, 'duplicate registration should be rejected');
    assert.strictEqual(duplicate.body.code, 'username_taken', 'duplicate registration should return a stable code');

    const badLogin = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: {
        userId: 'account_user',
        password: 'wrong password value',
      },
    });
    assert.strictEqual(badLogin.status, 401, 'wrong login password should be rejected');
    assert.strictEqual(badLogin.body.code, 'invalid_credentials', 'wrong login should not reveal which field failed');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejected = await fetchJson(port, '/account/api/login', {
        method: 'POST',
        body: { userId: 'account_user', password: 'wrong password value' },
      });
      assert.strictEqual(rejected.status, 401, 'attempts within the limit should still validate credentials');
    }
    const rateLimited = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: { userId: 'account_user', password: 'wrong password value' },
    });
    assert.strictEqual(rateLimited.status, 429, 'repeated login attempts should be rate-limited');
    assert.strictEqual(rateLimited.body.code, 'auth_rate_limited', 'rate limit should use a stable code');
    assert.ok(Number(rateLimited.retryAfter) >= 1, 'rate limit should return Retry-After');

    await delay(1100);
    const loggedIn = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: { userId: 'account_user', password: 'correct horse battery staple' },
    });
    assert.strictEqual(loggedIn.status, 200, 'login should recover after the rate window');

    const me = await fetchJson(port, '/account/api/me', { cookie: registered.cookie });
    assert.strictEqual(me.status, 200, 'session cookie should authenticate /me');
    assert.strictEqual(me.body.user.userId, 'account_user', 'session should identify the account');

    const baseWs = `ws://127.0.0.1:${port}/ws`;
    const agent = await connectClient(baseWs, 'agent', { token: registered.body.agentToken });
    const browser = await connectClient(baseWs, 'browser', { cookie: registered.cookie, browserId });

    try {
      agent.send(MESSAGE_TYPES.AGENT_HELLO, { deviceId: agentDeviceId, deviceName: 'Account Test PC' });
      await agent.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.DEVICE_LIST);
      await browser.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.DEVICE_SELECT, { deviceId: agentDeviceId });
      await browser.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' });
      const routed = await agent.waitFor((message) => message.type === MESSAGE_TYPES.RADIO_SET);
      assert.strictEqual(routed.payload.freq, '128.350', 'session browser commands should reach the account agent');
    } finally {
      agent.close();
      browser.close();
    }

    const sessions = await fetchJson(port, '/account/api/sessions', { cookie: registered.cookie });
    assert.strictEqual(sessions.status, 200, 'account should list browser sessions');
    assert.strictEqual(sessions.body.sessions.length, 2, 'registration and login should create two sessions');
    assert.strictEqual(sessions.body.sessions.filter((session) => session.current).length, 1, 'session list should mark the current session');

    const otherSession = sessions.body.sessions.find((session) => !session.current);
    const revokedSingle = await fetchJson(port, `/account/api/sessions/${encodeURIComponent(otherSession.sessionId)}/revoke`, {
      method: 'POST',
      cookie: registered.cookie,
    });
    assert.strictEqual(revokedSingle.status, 200, 'account should revoke one selected browser session');
    const revokedLoginSession = await fetchJson(port, '/account/api/me', { cookie: loggedIn.cookie });
    assert.strictEqual(revokedLoginSession.status, 401, 'revoked browser session should stop authenticating');

    const bulkLogin = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: { userId: 'account_user', password: 'correct horse battery staple' },
    });
    assert.strictEqual(bulkLogin.status, 200, 'account should create a session for bulk revocation');
    const revokedOthers = await fetchJson(port, '/account/api/sessions/revoke-others', {
      method: 'POST',
      cookie: registered.cookie,
    });
    assert.strictEqual(revokedOthers.status, 200, 'account should revoke other browser sessions');
    assert.strictEqual(revokedOthers.body.count, 1, 'one other session should be revoked in bulk');
    const revokedBulkSession = await fetchJson(port, '/account/api/me', { cookie: bulkLogin.cookie });
    assert.strictEqual(revokedBulkSession.status, 401, 'bulk-revoked browser session should stop authenticating');

    const extraLogin = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: { userId: 'account_user', password: 'correct horse battery staple' },
    });
    assert.strictEqual(extraLogin.status, 200, 'account should create another session before password change');
    const passwordChanged = await fetchJson(port, '/account/api/password/change', {
      method: 'POST',
      cookie: registered.cookie,
      body: {
        currentPassword: 'correct horse battery staple',
        newPassword: 'new correct horse battery staple',
      },
    });
    assert.strictEqual(passwordChanged.status, 200, 'account should change its password');
    assert.strictEqual(passwordChanged.body.revokedSessions, 1, 'password change should revoke the other browser session');
    const oldPassword = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: { userId: 'account_user', password: 'correct horse battery staple' },
    });
    assert.strictEqual(oldPassword.status, 401, 'old password should stop working');

    const recovery = await fetchJson(port, '/admin/api/users/account_user/password-reset', {
      method: 'POST',
      admin: true,
    });
    assert.strictEqual(recovery.status, 201, 'admin should create a one-time account recovery code');
    assert.match(recovery.body.code || '', /^VHF-RESET-/, 'recovery code should use the VoxHF prefix');
    const recovered = await fetchJson(port, '/account/api/password/recover', {
      method: 'POST',
      body: {
        userId: 'account_user',
        recoveryCode: recovery.body.code,
        newPassword: 'recovered correct horse battery staple',
      },
    });
    assert.strictEqual(recovered.status, 200, 'one-time recovery code should reset the password');
    assert.ok(recovered.cookie, 'password recovery should create a fresh browser session');
    accountCookie = recovered.cookie;
    const reusedRecovery = await fetchJson(port, '/account/api/password/recover', {
      method: 'POST',
      body: {
        userId: 'account_user',
        recoveryCode: recovery.body.code,
        newPassword: 'another recovered horse battery staple',
      },
    });
    assert.strictEqual(reusedRecovery.status, 401, 'recovery code should be usable only once');
    const revokedByRecovery = await fetchJson(port, '/account/api/me', { cookie: registered.cookie });
    assert.strictEqual(revokedByRecovery.status, 401, 'password recovery should revoke previous browser sessions');

    const rotated = await fetchJson(port, '/account/api/agent-token/rotate', {
      method: 'POST',
      cookie: accountCookie,
    });
    assert.strictEqual(rotated.status, 200, 'account token rotation should work');
    assert.ok(rotated.body.agentToken, 'rotation should return a new one-time token');
    assert.notStrictEqual(rotated.body.agentToken, registered.body.agentToken, 'rotation should replace the old token');

    await assertRejected(baseWs, registered.body.agentToken);
    await assertConnectsAs(baseWs, rotated.body.agentToken, 'account_user');

    const disabled = await fetchJson(port, '/admin/api/users/account_user/disable', {
      method: 'POST',
      admin: true,
    });
    assert.strictEqual(disabled.status, 200, 'admin should disable the account');
    const disabledSession = await fetchJson(port, '/account/api/me', { cookie: accountCookie });
    assert.strictEqual(disabledSession.status, 401, 'disabled accounts should lose existing browser sessions');

    console.log('[OK] relay account API');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function assertPrivacyDefaults(dbFile) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const session = db.prepare('SELECT ip_address AS ipAddress, user_agent AS userAgent FROM browser_sessions LIMIT 1').get();
    assert.ok(session, 'registration should create a browser session');
    assert.strictEqual(session.ipAddress, null, 'session IP should not persist by default');
    assert.strictEqual(session.userAgent, null, 'session user-agent should not persist by default');
    const auditCount = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
    assert.strictEqual(auditCount, 0, 'audit history should not persist by default');
    const acceptance = db.prepare(`
      SELECT terms_version AS termsVersion, privacy_version AS privacyVersion,
        legal_accepted_at AS acceptedAt, legal_acceptance_method AS method
      FROM users WHERE username = ?
    `).get('account_user');
    assert.strictEqual(acceptance.termsVersion, LEGAL.termsVersion, 'current terms version should be stored');
    assert.strictEqual(acceptance.privacyVersion, LEGAL.privacyVersion, 'current privacy version should be stored');
    assert.ok(acceptance.acceptedAt, 'legal acceptance timestamp should be stored');
    assert.strictEqual(acceptance.method, 'registration', 'legal acceptance method should be stored');
  } finally {
    db.close();
  }
}

function acceptedRegistration(body) {
  return {
    ...body,
    acceptTerms: true,
    acknowledgePrivacy: true,
    termsVersion: LEGAL.termsVersion,
    privacyVersion: LEGAL.privacyVersion,
  };
}

async function startRelay(options) {
  const relayProcess = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      VOXHF_RELAY_HOST: '127.0.0.1',
      VOXHF_RELAY_PORT: String(options.port),
      VOXHF_RELAY_AUTH_MODE: 'sqlite-fallback',
      VOXHF_RELAY_DATABASE: options.dbFile,
      VOXHF_RELAY_USERS: '',
      VOXHF_RELAY_TOKEN: '',
      VOXHF_ALLOWED_ORIGINS: allowedOrigin,
      VOXHF_RELAY_ENABLE_REGISTRATION: 'true',
      VOXHF_RELAY_REQUIRE_REGISTRATION_INVITE: 'true',
      VOXHF_RELAY_ADMIN_TOKEN: adminToken,
      VOXHF_RELAY_RATE_WINDOW_MS: '1000',
      VOXHF_RELAY_MAX_AUTH_ATTEMPTS_PER_WINDOW: '3',
      VOXHF_RELAY_REQUIRE_PAIRING: 'true',
      VOXHF_RELAY_DATA_DIR: options.dataDir,
      VOXHF_RELAY_PAIRINGS_FILE: path.join(options.dataDir, 'pairings.json'),
      VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN: 'false',
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

async function fetchJson(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      origin: options.origin || allowedOrigin,
      'content-type': options.contentType || 'application/json',
      ...(options.secureProxy ? { 'x-forwarded-proto': 'https' } : {}),
      ...(options.admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.rawBody !== undefined
      ? options.rawBody
      : options.body
        ? JSON.stringify(options.body)
        : undefined,
  });
  const body = await response.json().catch(() => ({}));
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0] || '';
  return {
    status: response.status,
    body,
    cookie,
    setCookie,
    retryAfter: response.headers.get('retry-after') || '',
  };
}

async function createInvite(port) {
  const response = await fetchJson(port, '/admin/api/registration-invites', {
    method: 'POST',
    admin: true,
  });
  assert.strictEqual(response.status, 201, 'admin should create a registration invite');
  assert.match(response.body.code || '', /^VHF-/, 'invite should use the VoxHF prefix');
  return response.body.code;
}

async function connectClient(baseWs, source, options) {
  const params = new URLSearchParams({ source });
  if (source === 'browser' && options.token) params.set('token', options.token);
  if (options.browserId) params.set('browserId', options.browserId);

  const ws = new WebSocket(`${baseWs}?${params.toString()}`, {
    origin: allowedOrigin,
    headers: source === 'agent'
      ? { authorization: `Bearer ${options.token}` }
      : options.cookie
        ? { cookie: options.cookie }
        : undefined,
  });
  const client = new RelayClient(source, ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  const identity = await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  assert.strictEqual(identity.payload.userId, 'account_user', `${source} should authenticate as account_user`);
  return client;
}

async function assertConnectsAs(baseWs, token, userId) {
  const ws = new WebSocket(`${baseWs}?source=agent`, {
    origin: allowedOrigin,
    headers: { authorization: `Bearer ${token}` },
  });
  const client = new RelayClient('agent-check', ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  const identity = await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  assert.strictEqual(identity.payload.userId, userId, `token should authenticate as ${userId}`);
  client.close();
}

async function assertRejected(baseWs, token) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWs}?source=agent`, {
      origin: allowedOrigin,
      headers: { authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('old token was not rejected'));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('old token unexpectedly connected'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      assert.ok(res.statusCode >= 400, 'old token should receive HTTP error');
      resolve();
    });
    ws.once('error', () => {});
  });
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
