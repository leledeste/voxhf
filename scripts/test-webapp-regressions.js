// Browser-state regression tests for the dependency-free operational webapp.
//
// The production script is evaluated inside a deliberately small fake DOM.
// This exercises the real state transitions without introducing a frontend
// framework or requiring network, audio, service-worker, or IVAO access.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const accountModule = require(path.join(root, 'webapp', 'account.js'));
const accountSource = fs.readFileSync(path.join(root, 'webapp', 'account.js'), 'utf8');
const weatherSource = fs.readFileSync(path.join(root, 'webapp', 'weather.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'webapp', 'app.js'), 'utf8');

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(String(this.element._className || '').split(/\s+/).filter(Boolean));
  }

  write(values) {
    this.element._className = [...values].join(' ');
  }

  add(...names) {
    const values = this.values();
    names.filter(Boolean).forEach(name => values.add(name));
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    names.forEach(name => values.delete(name));
    this.write(values);
  }

  contains(name) {
    return this.values().has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

function dataPropertyName(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function matchesSelector(element, selector) {
  const source = String(selector || '').trim();
  if (!source) return false;

  const tagMatch = source.match(/^[A-Za-z][A-Za-z0-9-]*/);
  if (tagMatch && element.tagName !== tagMatch[0].toUpperCase()) return false;

  for (const classMatch of source.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    if (!element.classList.contains(classMatch[1])) return false;
  }

  for (const attributeMatch of source.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
    const name = attributeMatch[1];
    const expected = attributeMatch[2];
    let actual;
    if (name.startsWith('data-')) actual = element.dataset[dataPropertyName(name)];
    else actual = element.getAttribute(name);
    if (actual === undefined || actual === null) return false;
    if (expected !== undefined && String(actual) !== expected) return false;
  }

  return true;
}

class FakeElement {
  constructor(document, tagName = 'div', id = '') {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.style = {
      removeProperty: name => {
        delete this.style[name];
      },
    };
    this._className = '';
    this._innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.title = '';
    this.href = '';
    this.type = '';
    this.scrollTop = 0;
    this.listeners = new Map();
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children.forEach(child => {
      child.parentNode = null;
    });
    this.children = [];
  }

  get scrollHeight() {
    return Math.max(0, this.children.length * 40);
  }

  get options() {
    return this.children.filter(child => child.tagName === 'OPTION');
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === 'class') this.className = text;
    if (name.startsWith('data-')) this.dataset[dataPropertyName(name)] = text;
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name.startsWith('data-')) return this.dataset[dataPropertyName(name)];
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this.dataset[dataPropertyName(name)];
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach(child => {
      if (child instanceof FakeElement) this.appendChild(child);
      else this.textContent += String(child);
    });
  }

  prepend(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.unshift(child);
  }

  insertBefore(child, reference) {
    if (!reference || !this.children.includes(reference)) return this.appendChild(child);
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach(child => {
      child.parentNode = null;
    });
    this.children = [];
    children.forEach(child => this.appendChild(child));
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {}

  reset() {
    this.querySelectorAll('input').forEach(input => {
      input.value = '';
    });
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.activeElement = null;
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.body);
    this.seedStaticElements();
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  register(element, parent = this.body) {
    if (element.id) this.elements.set(element.id, element);
    if (parent && element.parentNode !== parent) parent.appendChild(element);
    return element;
  }

  createRegistered(id, options = {}) {
    const element = new FakeElement(this, options.tagName || 'div', id);
    element.className = options.className || '';
    Object.assign(element.dataset, options.dataset || {});
    if (options.value !== undefined) element.value = options.value;
    return this.register(element, options.parent || this.body);
  }

  seedStaticElements() {
    this.createRegistered('settings-modal', { className: 'hidden' });
    this.createRegistered('notification-agent-offline-confirm', { className: 'hidden' });

    const settingsTabs = this.createRegistered('settings-tabs', { className: 'settings-tabs' });
    for (const tab of ['audio', 'connection', 'remote', 'notifications', 'about']) {
      this.createRegistered(`settings-tab-${tab}`, {
        tagName: 'button',
        className: 'settings-tab',
        dataset: { settingsTab: tab },
        parent: settingsTabs,
      });
      this.createRegistered(`settings-page-${tab}`, {
        tagName: 'section',
        className: 'settings-page hidden',
        dataset: { settingsPage: tab },
      });
    }

    const tabs = this.createRegistered('chat-tabs', { className: 'tabs' });
    for (const filter of ['all', 'frequency', 'private', 'system']) {
      this.createRegistered(`chat-tab-${filter}`, {
        tagName: 'button',
        className: 'tab',
        dataset: { filter },
        parent: tabs,
      });
    }

    const recipient = this.createRegistered('recipient', { tagName: 'select', value: '@22800' });
    const frequency = this.createElement('option');
    frequency.value = '@22800';
    recipient.appendChild(frequency);

    for (const com of [1, 2]) {
      this.createRegistered(`com${com}-select`, { tagName: 'select' });
      this.createRegistered(`com${com}-input`, { tagName: 'input' });
    }
  }

  getElementById(id) {
    if (this.elements.has(id)) return this.elements.get(id);
    const tagName = /(?:input|code)$/.test(id) ? 'input' : 'div';
    const element = this.createRegistered(id, { tagName });
    if (['settings-account-security', 'settings-account-token', 'remote-pill'].includes(id)) {
      element.classList.add('hidden');
    }
    return element;
  }

  querySelectorAll(selector) {
    const matches = [];
    if (matchesSelector(this.documentElement, selector)) matches.push(this.documentElement);
    matches.push(...this.documentElement.querySelectorAll(selector));
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  async dispatch(type, event = {}) {
    const listeners = [...(this.listeners.get(type) || [])];
    await Promise.all(listeners.map(listener => listener({ type, ...event })));
  }

  execCommand() {
    return true;
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url = '') {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.resumeAllowed = true;
    this.resumeCalls = 0;
  }

  async resume() {
    this.resumeCalls += 1;
    if (this.resumeAllowed) this.state = 'running';
  }
}

function createHarness(options = {}) {
  const document = new FakeDocument();
  const storage = new Map();
  const timeouts = new Map();
  let timeoutSequence = 0;
  const scrollCalls = [];

  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    clear: () => storage.clear(),
  };

  const location = {
    href: 'http://localhost/app.html?local=1',
    protocol: 'http:',
    hostname: 'localhost',
    host: 'localhost',
    pathname: '/app.html',
    search: '?local=1',
    hash: '',
    replace() {},
    reload() {},
  };

  const window = {
    document,
    location,
    localStorage,
    isSecureContext: true,
    scrollY: 0,
    PointerEvent: function PointerEvent() {},
    VoxHFWeather: null,
    addEventListener() {},
    confirm: () => true,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    scrollTo: (x, y) => scrollCalls.push([x, y]),
  };

  const Notification = function Notification() {};
  Notification.permission = 'default';
  window.Notification = Notification;

  const navigator = {
    platform: 'Test Browser',
    userAgent: 'VoxHF frontend regression test',
    maxTouchPoints: 0,
    standalone: false,
    ...(options.navigator || {}),
  };

  const context = vm.createContext({
    __VOXHF_FRONTEND_TEST__: true,
    window,
    document,
    location,
    navigator,
    localStorage,
    Notification,
    WebSocket: FakeWebSocket,
    AudioContext: FakeAudioContext,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob,
    crypto: crypto.webcrypto,
    console,
    setTimeout: (callback, delay) => {
      const id = ++timeoutSequence;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timeouts.delete(id),
    setInterval: () => 0,
    clearInterval() {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  });
  context.globalThis = context;

  vm.runInContext(accountSource, context, { filename: 'webapp/account.js' });
  vm.runInContext(weatherSource, context, { filename: 'webapp/weather.js' });
  vm.runInContext(appSource, context, { filename: 'webapp/app.js' });
  return {
    app: context.__VOXHF_FRONTEND_TEST_HOOKS__,
    document,
    localStorage,
    scrollCalls,
    storage,
    timeouts,
    window,
  };
}

function remoteEnvelope(type, payload) {
  return { v: 1, id: `test-${type}`, type, payload };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('chat history survives duplicate recovery and closing a private tab', () => {
  const { app } = createHarness();
  app.state.callsign = 'MHL212';
  const history = [
    {
      sender: 'EPRZ_TWR',
      recipient: 'MHL212',
      text: 'Contact me on 126.805',
      timestamp: '2026-08-02T10:00:00.000Z',
      direction: 'incoming',
      messageId: 'private-in-1',
    },
    {
      sender: 'MHL212',
      recipient: 'EPRZ_TWR',
      text: '126.805, MHL212',
      timestamp: '2026-08-02T10:00:05.000Z',
      direction: 'outgoing',
      messageId: 'private-out-1',
    },
    {
      sender: 'MHL212',
      recipient: '@22800',
      text: 'Traffic report',
      timestamp: '2026-08-02T10:01:00.000Z',
      direction: 'outgoing',
      messageId: 'frequency-1',
    },
  ];

  const envelope = remoteEnvelope(app.REMOTE_MESSAGE_TYPES.CHAT_HISTORY, { messages: history });
  app.handleRemoteRelayMessage(envelope);
  app.handleRemoteRelayMessage(envelope);

  assert.strictEqual(app.state.messages.length, 3, 'history replay must not duplicate messages');
  assert(app.state.privatePeers.has('EPRZ_TWR'), 'private history must restore its peer tab');
  app.setActiveChatFilter('private-peer', 'EPRZ_TWR');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 2);

  const messageCount = app.state.messages.length;
  app.closePrivateChat('EPRZ_TWR');
  assert.strictEqual(app.state.messages.length, messageCount, 'closing a tab must not delete history');
  assert.strictEqual(app.state.filter, 'private', 'closing the active peer must fall back to Private');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 2);

  app.setActiveChatFilter('all');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 3);
});

test('frequency chat keeps UNICOM and active COM traffic only', () => {
  const { app } = createHarness();
  app.state.comFrequencies[1] = '126.805';
  app.state.comFrequencies[2] = '131.055';

  const unicom = { type: 'frequency', recipient: '@22800', direction: 'incoming' };
  const com1 = { type: 'frequency', recipient: '@26805', direction: 'incoming' };
  const com2 = { type: 'frequency', recipient: '@31055', direction: 'incoming' };
  const unrelated = { type: 'frequency', recipient: '@25000', direction: 'incoming' };
  const sentElsewhere = { type: 'frequency', recipient: '@25000', direction: 'outgoing' };
  const privateMessage = { type: 'private', recipient: 'MHL212', direction: 'incoming' };

  app.state.filter = 'all';
  assert.strictEqual(app.messageMatchesCurrentTab(unicom), true, 'UNICOM must remain visible');
  assert.strictEqual(app.messageMatchesCurrentTab(com1), true, 'COM1 traffic must remain visible');
  assert.strictEqual(app.messageMatchesCurrentTab(com2), true, 'COM2 traffic must remain visible');
  assert.strictEqual(app.messageMatchesCurrentTab(unrelated), false, 'untuned frequency traffic must be hidden');
  assert.strictEqual(app.messageMatchesCurrentTab(sentElsewhere), true, 'sent messages must remain visible');
  assert.strictEqual(app.messageMatchesCurrentTab(privateMessage), true, 'private chat behavior must remain unchanged');

  app.state.filter = 'frequency';
  assert.strictEqual(app.messageMatchesCurrentTab(unicom), true);
  assert.strictEqual(app.messageMatchesCurrentTab(com1), true);
  assert.strictEqual(app.messageMatchesCurrentTab(com2), true);
  assert.strictEqual(app.messageMatchesCurrentTab(unrelated), false);
  assert.strictEqual(app.messageMatchesCurrentTab(privateMessage), false);

  app.state.comFrequencies[1] = '125.000';
  assert.strictEqual(app.messageMatchesCurrentTab(com1), false, 'old COM traffic must hide after retuning');
  assert.strictEqual(app.messageMatchesCurrentTab(unrelated), true, 'new COM traffic must become visible');
});

test('Settings locks and restores the workspace scroll position', () => {
  const { app, document, scrollCalls, window } = createHarness();
  window.scrollY = 284;

  app.openSettings('notifications');
  assert(!document.getElementById('settings-modal').classList.contains('hidden'));
  assert(document.body.classList.contains('settings-open'));
  assert.strictEqual(document.body.style.top, '-284px');
  assert(document.getElementById('settings-tab-notifications').classList.contains('active'));
  assert(!document.getElementById('settings-page-notifications').classList.contains('hidden'));

  window.scrollY = 999;
  app.openSettings('audio');
  assert.strictEqual(app.state.settingsScrollY, 284, 'switching page must preserve the original lock');
  app.closeSettings();

  assert(document.getElementById('settings-modal').classList.contains('hidden'));
  assert(!document.body.classList.contains('settings-open'));
  assert.strictEqual(document.body.style.top, undefined);
  assert.deepStrictEqual(scrollCalls.at(-1), [0, 284]);
});

test('mobile RX audio recovery remains available after iOS suspends the output', async () => {
  const { app, document } = createHarness({
    navigator: {
      platform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      maxTouchPoints: 5,
    },
  });

  app.updateRxActivationPrompt();
  assert(!document.getElementById('rx-activation-prompt').classList.contains('hidden'));
  app.bindAudioUnlock();
  assert.strictEqual(app.state.audioUnlockBound, true);
  assert.strictEqual(document.listeners.get('pointerdown').length, 1);
  assert.strictEqual(document.listeners.get('touchstart').length, 1);

  await document.dispatch('pointerdown');
  assert.strictEqual(app.state.audioCtx.state, 'running');
  assert(document.getElementById('rx-activation-prompt').classList.contains('hidden'));
  assert.strictEqual(app.state.audioUnlockBound, true, 'the recovery listener should remain available');
  assert.strictEqual(document.listeners.get('pointerdown').length, 1);
  assert.strictEqual(document.listeners.get('touchstart').length, 1);

  app.state.audioCtx.state = 'interrupted';
  app.state.audioCtx.resumeAllowed = false;
  app.updateRxActivationPrompt();
  await app.resumeAudioIfNeeded();
  assert.strictEqual(app.state.audioUnlockBound, true);
  assert(!document.getElementById('rx-activation-prompt').classList.contains('hidden'));

  app.state.audioCtx.resumeAllowed = true;
  await document.dispatch('touchstart');
  assert.strictEqual(app.state.audioCtx.state, 'running');
  assert(document.getElementById('rx-activation-prompt').classList.contains('hidden'));
  assert.strictEqual(app.state.audioUnlockBound, true);
  assert.strictEqual(document.listeners.get('touchstart').length, 1);
});

test('RX activation prompt is limited to iOS and iPadOS', () => {
  const desktop = createHarness();
  desktop.app.updateRxActivationPrompt();
  assert.strictEqual(desktop.app.isIosDevice(), false);
  assert(desktop.document.getElementById('rx-activation-prompt').classList.contains('hidden'));

  const ipad = createHarness({
    navigator: {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      maxTouchPoints: 5,
    },
  });
  ipad.app.updateRxActivationPrompt();
  assert.strictEqual(ipad.app.isIosDevice(), true);
  assert(!ipad.document.getElementById('rx-activation-prompt').classList.contains('hidden'));
});

test('notification choices remain per device and shape the subscription payload', () => {
  const { app } = createHarness();
  app.saveNotificationOnlinePreference(true);
  app.saveNotificationAgentOfflinePreference(true);
  assert.strictEqual(app.loadNotificationOnlinePreference(), true);
  assert.strictEqual(app.loadNotificationAgentOfflinePreference(), true);

  app.state.notifications.notifyIvaoConnected = true;
  app.state.notifications.notifyAgentOffline = true;
  app.state.notifications.vapidPublicKey = 'test-vapid-key';
  app.state.generation = 7;
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/device-1',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    }),
  };

  app.state.remote.enabled = false;
  const localPayload = app.notificationSubscriptionPayload(subscription);
  assert.strictEqual(localPayload.notifyIvaoConnected, true);
  assert.strictEqual(localPayload.notifyAgentOffline, false, 'proxy-offline alerts require remote mode');
  assert.strictEqual(localPayload.deviceId, app.state.remoteBrowserId);

  app.state.remote.enabled = true;
  app.state.remoteSelectedDeviceId = 'agent-one';
  const remotePayload = app.notificationSubscriptionPayload(subscription);
  assert.strictEqual(remotePayload.notifyAgentOffline, true);
  const enabledSignature = app.notificationSubscriptionSignature(remotePayload);

  app.state.notifications.notifyAgentOffline = false;
  const disabledPayload = app.notificationSubscriptionPayload(subscription);
  assert.notStrictEqual(app.notificationSubscriptionSignature(disabledPayload), enabledSignature);

  app.saveNotificationOnlinePreference(false);
  app.saveNotificationAgentOfflinePreference(false);
  assert.strictEqual(app.loadNotificationOnlinePreference(), false);
  assert.strictEqual(app.loadNotificationAgentOfflinePreference(), false);
});

test('workspace account controller owns status, sessions, security, and logout flows', async () => {
  const document = new FakeDocument();
  const savedValues = new Map();
  const storage = {
    getItem: key => savedValues.get(key) ?? null,
    setItem: (key, value) => savedValues.set(key, String(value)),
    removeItem: key => savedValues.delete(key),
  };
  const state = {
    remote: { enabled: true, relay: 'wss://relay.example/ws', token: '' },
    account: { authenticated: false, userId: '', userName: '', sessions: [] },
    authOverlayDismissed: false,
  };
  const responses = [];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected account request: ${url}`);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      json: async () => response.body || {},
    };
  };
  const location = {
    href: 'http://localhost/app.html?remote=1',
    protocol: 'http:',
    pathname: '/app.html',
    search: '?remote=1',
    hash: '',
    replaced: '',
    replace(value) { this.replaced = value; },
  };
  let workspaceUpdates = 0;
  let connectArgument = null;
  const remoteChecks = [];
  const localMessages = [];
  const errorMessages = [];
  const manualPreferences = [];

  const controller = accountModule.createAccountController({
    state,
    storage,
    document,
    location,
    fetchImpl,
    getElement: id => document.getElementById(id),
    getRelay: () => state.remote.relay,
    getAccountLabel: () => state.account.userName,
    updateWorkspace: () => { workspaceUpdates += 1; },
    setRemoteCheck: status => remoteChecks.push(status),
    addLocal: message => localMessages.push(message),
    addErrorMessage: message => errorMessages.push(message),
    saveManualPreference: enabled => manualPreferences.push(enabled),
    connect: force => { connectArgument = force; },
    closeSettings: () => {},
    confirmAction: () => true,
  });

  responses.push(
    { body: { authenticated: true, user: { userId: 'pilot-one', userName: 'Pilot One' } } },
    { body: { sessions: [
      { sessionId: 'current-session', current: true, lastSeenAt: '2026-08-02T10:00:00.000Z' },
      { sessionId: 'other-session', current: false, lastSeenAt: '2026-08-02T09:00:00.000Z', userAgent: 'iPhone' },
    ] } },
  );
  assert.strictEqual(await controller.refreshStatus(), true);
  assert.strictEqual(state.account.authenticated, true);
  assert.strictEqual(state.account.userId, 'pilot-one');
  assert.strictEqual(state.account.sessions.length, 2);
  assert.deepStrictEqual(accountModule.loadStoredAccount(storage), { userId: 'pilot-one', userName: 'Pilot One' });
  assert.strictEqual(requests[0].url, 'https://relay.example/account/api/status');
  assert.strictEqual(requests[0].options.credentials, 'include');
  assert.strictEqual(document.getElementById('settings-account-sessions').children.length, 2);
  assert.strictEqual(workspaceUpdates, 1);

  const currentPassword = document.getElementById('settings-account-current-password');
  const newPassword = document.getElementById('settings-account-new-password');
  const confirmation = document.getElementById('settings-account-confirm-password');
  currentPassword.value = 'old-password';
  newPassword.value = 'new-password-123';
  confirmation.value = 'new-password-123';
  responses.push(
    { body: { revokedSessions: 1 } },
    { body: { sessions: [{ sessionId: 'current-session', current: true }] } },
  );
  await controller.changePassword({ preventDefault() {} });
  const passwordRequest = requests.find(request => request.url.endsWith('/account/api/password/change'));
  assert.deepStrictEqual(JSON.parse(passwordRequest.options.body), {
    currentPassword: 'old-password',
    newPassword: 'new-password-123',
  });
  assert.match(document.getElementById('settings-account-security-status').textContent, /^Password changed\./);

  responses.push({ body: { agentToken: 'agent-token-once' } });
  await controller.rotateAgentToken();
  assert.match(document.getElementById('settings-account-token').textContent, /agent-token-once/);
  assert(localMessages.some(message => message.startsWith('Agent token rotated.')));
  assert.deepStrictEqual(errorMessages, []);

  responses.push(
    { body: { count: 1 } },
    { body: { sessions: [{ sessionId: 'current-session', current: true }] } },
  );
  await controller.revokeOtherSessions();
  assert(requests.some(request => request.url.endsWith('/account/api/sessions/revoke-others')));

  responses.push({ body: { ok: true } });
  await controller.logout();
  assert.strictEqual(state.account.authenticated, false);
  assert.strictEqual(state.account.userId, '');
  assert.strictEqual(connectArgument, true);
  assert(remoteChecks.includes('Account logged out'));
  assert(manualPreferences.includes(false));

  state.remote.enabled = true;
  state.remote.token = '';
  state.authOverlayDismissed = false;
  controller.updateGate();
  assert(!document.getElementById('auth-overlay').classList.contains('hidden'));
  state.account.authenticated = true;
  controller.updateGate();
  assert(document.getElementById('auth-overlay').classList.contains('hidden'));
});

test('UNICOM timer state, actions, and expiry feedback stay synchronized', () => {
  const { app, document } = createHarness();
  const startedAt = new Date(Date.now() - 60000).toISOString();
  const expiresAt = new Date(Date.now() + 120000).toISOString();

  app.applyUnicomTimerState({ active: true, startedAt, expiresAt });
  assert.strictEqual(app.state.unicomTimer.active, true);
  assert.match(document.getElementById('unicom-timer-display').textContent, /^Cancel 2:0[01]$/);
  assert.strictEqual(document.getElementById('unicom-timer-toggle').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(app.formatTimerDuration(180), '3:00');
  assert.strictEqual(app.formatTimerDuration(5), '0:05');

  app.applyUnicomTimerState({ active: false });
  app.state.controlsDisabled = false;
  const socket = new FakeWebSocket();
  socket.readyState = FakeWebSocket.OPEN;
  app.state.ws = socket;
  app.state.remote.enabled = false;
  app.toggleUnicomTimer();
  assert.strictEqual(app.state.unicomTimer.pending, true);
  assert.deepStrictEqual(JSON.parse(socket.sent[0]), { action: 'unicom_timer_start' });

  app.handleUnicomTimerExpired({ expiredAt: '2026-08-02T10:03:00.000Z' });
  assert.strictEqual(app.state.unicomTimer.active, false);
  assert(app.state.messages.some(message => message.text.startsWith('UNICOM three-minute timer expired')));
});

test('remote device selection always requests chat history without notifications', () => {
  const { app } = createHarness();
  const socket = new FakeWebSocket();
  socket.readyState = FakeWebSocket.OPEN;
  app.state.ws = socket;
  app.state.remote.enabled = true;
  app.state.remote.relay = 'wss://relay.example/ws';
  app.state.remoteSelectedDeviceId = '';
  app.state.notifications.available = false;
  app.state.notifications.subscribed = false;
  app.state.remoteDevices.set('agent-one', { deviceId: 'agent-one', deviceName: 'Flight PC', online: true });

  app.selectRemoteDevice('agent-one', { force: true });
  const messages = socket.sent.map(value => JSON.parse(value));
  assert.deepStrictEqual(messages.map(message => message.type), [
    app.REMOTE_MESSAGE_TYPES.DEVICE_SELECT,
    app.REMOTE_MESSAGE_TYPES.CHAT_HISTORY_REQUEST,
  ]);
  assert.deepStrictEqual(messages[0].payload, { deviceId: 'agent-one' });
  assert.deepStrictEqual(messages[1].payload, {});
});

test('radio, transponder, flight-plan, and weather updates reach visible state', () => {
  const { app, document } = createHarness();

  app.handleMessage({ kind: 'atc_detected', callsign: 'EPRZ_TWR', freq: '126.805' });
  app.handleMessage({ kind: 'freq_update', com: 1, freq: '126.805', station: 'EPRZ_TWR' });
  app.applyRemoteRadioState({ com2: '122.800', station2: 'UNICOM' });
  assert.strictEqual(app.state.comFrequencies[1], '126.805');
  assert.strictEqual(app.state.comStations[1], 'EPRZ_TWR');
  assert.strictEqual(document.getElementById('com1-label').textContent, '126.805 MHz');
  assert.strictEqual(app.state.comFrequencies[2], '122.800');

  app.applyXpdrState({ squawk: '4621', mode: 'alt' });
  assert.strictEqual(app.state.squawk, '4621');
  assert.strictEqual(app.state.xpdrMode, 'alt');
  assert.strictEqual(document.getElementById('xpdr-code').value, '4621');
  app.applyXpdrState({ squawk: '9999', mode: 'invalid' });
  assert.strictEqual(app.state.squawk, '4621', 'invalid network squawk must be ignored');
  assert.strictEqual(app.state.xpdrMode, 'alt', 'invalid network mode must be ignored');

  app.applyRemoteWeatherState({
    flightPlanStatus: 'filed',
    flightPlan: { departure: 'lirf', destination: 'egll', alternate: 'egkk' },
    weatherState: {
      departure: {
        icao: 'lirf',
        metar: { text: 'LIRF 021020Z 23008KT CAVOK', receivedAt: '2026-08-02T10:20:00.000Z', source: 'IVAO' },
      },
      destination: {
        icao: 'egll',
        taf: { text: 'TAF EGLL 021100Z 0212/0318 25010KT', receivedAt: '2026-08-02T10:21:00.000Z', source: 'IVAO' },
      },
    },
  });
  assert.strictEqual(app.state.flightPlan.departure, 'LIRF');
  assert.strictEqual(app.state.flightPlan.destination, 'EGLL');
  assert.strictEqual(document.getElementById('flight-plan-text').textContent, 'LIRF-EGLL');
  assert.strictEqual(document.getElementById('settings-flight-plan').textContent, 'LIRF -> EGLL');
  assert.match(document.getElementById('weather-panel').innerHTML, /LIRF 021020Z 23008KT CAVOK/);
  assert.match(document.getElementById('weather-panel').innerHTML, /TAF EGLL 021100Z/);
});

test('weather interpreter explains unavailable fields and keeps remarks together', () => {
  const { window } = createHarness();
  const metar = window.VoxHFWeather.interpretMetar(
    'MKJP 020800Z 11007KT //// ////// 28/24 Q1013 RMK CLD FROM CEILOMETER RWY 30 NCD',
  );

  assert.ok(metar);
  assert.ok(metar.rows.some(row => row.label === 'Visibility' && row.value === 'Not available'));
  assert.ok(metar.rows.some(row => row.label === 'Cloud' && row.value === 'Not available'));
  assert.ok(metar.rows.some(row => (
    row.label === 'Remarks'
      && row.value === 'Runway 30 ceilometer: no cloud detected'
  )));
  assert.ok(!metar.rows.some(row => row.label === 'Not interpreted'));

  const taf = window.VoxHFWeather.interpretTaf(
    'TAF MKJP 020800Z 0209/0315 11007KT //// ////// RMK SENSOR DATA UNAVAILABLE',
  );
  assert.ok(taf.rows.some(row => (
    row.label === 'Base forecast Visibility' && row.value === 'Not available'
  )));
  assert.ok(taf.rows.some(row => (
    row.label === 'Base forecast Cloud' && row.value === 'Not available'
  )));
  assert.ok(taf.rows.some(row => (
    row.label === 'Base forecast Remarks' && row.value === 'SENSOR DATA UNAVAILABLE'
  )));
  assert.ok(!taf.rows.some(row => row.label === 'Not interpreted'));
});

async function runTests() {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`[OK] ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`[FAIL] ${name}`);
      console.error(`       ${error.stack || error.message}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} frontend regression test(s) failed.`);
    process.exit(1);
  }

  console.log(`\n${tests.length} frontend regression tests passed.`);
}

runTests().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
