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
const { notificationTrigger } = require('../proxy/push-notifications');

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
    this._scrollTop = 0;
    this.clientHeight = 200;
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
    this._scrollTop = 0;
  }

  get scrollHeight() {
    return Math.max(this.clientHeight, this.children.length * 40);
  }

  get scrollTop() { return this._scrollTop; }

  set scrollTop(value) {
    this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }

  getBoundingClientRect() {
    const parent = this.parentNode;
    const top = parent
      ? parent.getBoundingClientRect().top + parent.children.indexOf(this) * 40 - parent.scrollTop
      : 0;
    return { top, bottom: top + 40 };
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

  setPointerCapture() { this.pointerCaptured = true; }
  hasPointerCapture() { return Boolean(this.pointerCaptured); }
  releasePointerCapture() { this.pointerCaptured = false; }
  contains(element) { return this.children.includes(element); }

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
    for (const tab of ['audio', 'connection', 'remote', 'notifications', 'chat', 'about']) {
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
    for (const filter of ['all', 'frequency', 'for-you', 'system']) {
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
    this.destination = {};
    this.sources = [];
  }

  createBuffer(channels, length, rate) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    const source = {
      connect(destination) { this.destination = destination; },
      disconnect() { this.disconnected = true; },
      start(when) { this.when = when; },
      stop() { this.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }

  async resume() {
    this.resumeCalls += 1;
    if (this.resumeAllowed) this.state = 'running';
  }
}

function createHarness(options = {}) {
  const document = new FakeDocument();
  const storage = options.storage || new Map();
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
    prompt: options.prompt || (() => null),
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
  assert.strictEqual(app.state.filter, 'for-you', 'closing the active peer must fall back to For you');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 1);

  app.setActiveChatFilter('all');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 3);
});

test('chat layout moves all tab kinds without changing conversation, draft, unread or scroll', () => {
  const { app, document } = createHarness();
  app.openPrivateChat('ONE');
  document.getElementById('message-input').value = 'Unsent reply';
  app.addMessage({ kind: 'message', type: 'private', sender: 'TWO', messageId: 'layout-in', text: 'Hello' });
  const count = app.state.privatePeers.get('TWO').unread;
  const messages = app.state.messages;
  const scroll = document.getElementById('messages').scrollTop;
  app.reorderChatTab('private:TWO', 'all');
  app.moveChatTab('system', -1);
  assert.strictEqual(app.state.chatTabOrder[0], 'private:TWO');
  assert.strictEqual(document.querySelector('.tabs').children[0].dataset.peer, 'TWO');
  assert.strictEqual(app.state.privatePeer, 'ONE');
  assert.strictEqual(document.getElementById('recipient').value, 'private:ONE');
  assert.strictEqual(document.getElementById('message-input').value, 'Unsent reply');
  assert.strictEqual(app.state.privatePeers.get('TWO').unread, count);
  assert.strictEqual(app.state.messages, messages);
  assert.strictEqual(document.getElementById('messages').scrollTop, scroll);
  app.closePrivateChat('TWO');
  app.openPrivateChat('TWO');
  assert.strictEqual(app.state.chatTabOrder[0], 'private:TWO', 'reopening retains its position');
});

test('hidden filters and private tabs persist without storing messages or drafts', () => {
  const { app, document, storage } = createHarness();
  app.addMessage({ kind: 'message', type: 'private', sender: 'ONE', messageId: 'old', text: 'PRIVATE CONTENT', timestamp: '2026-09-16T10:00:00Z' });
  app.openPrivateChat('ONE');
  document.getElementById('message-input').value = 'PRIVATE DRAFT';
  app.setChatFilterVisible('for-you', false);
  app.closePrivateChat('ONE');
  assert.strictEqual(app.state.filter, 'all', 'hidden For you must not become the fallback');
  app.reorderChatTab('system', 'all');
  app.setChatFilterVisible('all', false);
  assert(!app.state.hiddenChatFilters.has('all'));
  const saved = [...storage.values()].join(' ');
  assert(!saved.includes('PRIVATE CONTENT'));
  assert(!saved.includes('PRIVATE DRAFT'));
  const restarted = createHarness({ storage });
  restarted.app.syncChatLayout();
  assert.strictEqual(restarted.app.state.chatTabOrder[0], 'system');
  assert(restarted.app.state.hiddenChatFilters.has('for-you'));
  assert(restarted.app.state.privatePeers.get('ONE').hidden);
  assert.strictEqual(restarted.app.state.messages.length, 0);
  assert.strictEqual(restarted.app.state.chatDrafts.size, 0);
  restarted.app.addMessage({ kind: 'message', type: 'private', sender: 'ONE', messageId: 'old', text: 'Old', timestamp: '2026-09-16T10:00:00Z' }, true);
  assert(restarted.app.state.privatePeers.get('ONE').hidden, 'history must not undo hiding');
  restarted.app.addMessage({ kind: 'message', type: 'private', sender: 'ONE', messageId: 'new', text: 'New', timestamp: '2026-09-16T10:01:00Z' }, true);
  assert(!restarted.app.state.privatePeers.get('ONE').hidden, 'missed newer history should reveal the tab');
  restarted.app.closePrivateChat('ONE');
  restarted.app.addMessage({ kind: 'message', type: 'private', sender: 'ONE', messageId: 'live', text: 'New live', timestamp: '2020-01-01T00:00:00Z' });
  assert(!restarted.app.state.privatePeers.get('ONE').hidden, 'live incoming must reveal even after a source clock change');
});

test('chat layout is isolated by local mode, relay, account and selected agent', () => {
  const { app } = createHarness();
  app.setChatFilterVisible('system', false);
  app.state.remote.enabled = true;
  app.state.remote.relay = 'https://relay.example';
  app.state.remoteIdentity.userId = 'alice';
  app.state.remoteSelectedDeviceId = 'pc-a';
  app.syncChatLayout();
  assert(!app.state.hiddenChatFilters.has('system'));
  app.setChatFilterVisible('frequency', false);
  app.openPrivateChat('ALICE_PEER');
  app.state.remoteSelectedDeviceId = 'pc-b';
  app.syncChatLayout();
  assert(!app.state.hiddenChatFilters.has('frequency'));
  assert(!app.state.privatePeers.has('ALICE_PEER'));
  app.state.remoteSelectedDeviceId = 'pc-a';
  app.syncChatLayout();
  assert(app.state.hiddenChatFilters.has('frequency'));
  assert(app.state.privatePeers.has('ALICE_PEER'));
  app.state.remoteIdentity.userId = 'bob';
  app.syncChatLayout();
  assert(!app.state.privatePeers.has('ALICE_PEER'));
  app.state.remoteIdentity.userId = 'alice';
  app.state.remote.relay = 'https://other.example';
  app.syncChatLayout();
  assert(!app.state.hiddenChatFilters.has('frequency'));
  app.state.remote.enabled = false;
  app.syncChatLayout();
  assert(app.state.hiddenChatFilters.has('system'));
});

test('chat layout tolerates invalid preferences and unavailable browser storage', () => {
  const storage = new Map([['voxhf.chatLayout.v1:["local"]', JSON.stringify({
    order: ['all', 'all', 'bogus', 'private:<script>', 'system'], hiddenFilters: ['all', 'bogus', 'system'], hiddenPeers: {},
  })]]);
  const { app, localStorage, document } = createHarness({ storage });
  app.syncChatLayout();
  assert.strictEqual(app.state.chatTabOrder.join(','), 'all,system,frequency,for-you');
  assert.strictEqual([...app.state.hiddenChatFilters].join(','), 'system');
  localStorage.setItem = () => { throw new Error('Storage blocked'); };
  app.moveChatTab('system', -1);
  assert.strictEqual(app.state.chatTabOrder[0], 'system');
  app.renderChatSettings();
  assert.match(document.getElementById('settings-chat-storage').textContent, /unavailable/);
  const corrupt = createHarness({ storage: new Map([['voxhf.chatLayout.v1:["local"]', '{bad']]) });
  corrupt.app.syncChatLayout();
  assert.strictEqual(corrupt.app.state.chatTabOrder.join(','), 'all,frequency,for-you,system');
  assert.strictEqual(corrupt.app.state.chatLayoutSaved, false);
});

test('touch and keyboard chat settings keep focus and preserve private drafts', () => {
  const { app, document } = createHarness();
  app.openPrivateChat('ONE');
  document.getElementById('message-input').value = 'Keep this';
  app.openSettings('chat');
  const list = document.getElementById('settings-chat-list');
  const find = (key, action) => [...list.querySelectorAll('button')].find(button => button.dataset.chatKey === key && button.dataset.chatAction === action);
  const up = find('private:ONE', 'up');
  up.focus();
  up.onclick();
  assert.strictEqual(document.activeElement.dataset.chatKey, 'private:ONE');
  assert.strictEqual(document.activeElement.dataset.chatAction, 'up');
  find('private:ONE', 'visibility').onclick();
  assert(app.state.privatePeers.get('ONE').hidden);
  find('private:ONE', 'visibility').onclick();
  app.openPrivateChat('ONE');
  assert.strictEqual(document.getElementById('message-input').value, 'Keep this');
  assert(find('all', 'visibility').disabled);
});

test('mouse drag reorders tabs without selecting them and leaves touch scrolling alone', () => {
  const { app, document } = createHarness();
  app.setActiveChatFilter('all');
  app.bindChatTabDrag();
  const tabs = document.querySelector('.tabs');
  const tab = key => [...tabs.children].find(item => item.dataset.filter === key);
  const dispatch = (type, target, x = 100, pointerType = 'mouse') => (type === 'pointerup' ? document : tabs).listeners.get(type).forEach(listener => listener({
    target: { closest: selector => selector === '.tab' ? target : null },
    preventDefault() {}, stopImmediatePropagation() {}, clientX: x, clientY: 10, pointerId: 1, button: 0, pointerType,
  }));
  dispatch('pointerup', tab('system'));
  assert.strictEqual(app.state.chatTabOrder[0], 'all');
  document.elementFromPoint = () => ({ closest: () => tab('all') });
  dispatch('pointerdown', tab('system'));
  dispatch('pointermove', tab('all'), 150);
  dispatch('pointerup', tab('all'), 150);
  assert.strictEqual(app.state.chatTabOrder[0], 'system');
  assert.strictEqual(app.state.filter, 'all');
  assert.strictEqual(app.state.draggedChatTab, '');
  dispatch('pointerdown', tab('frequency'), 100, 'touch');
  dispatch('pointermove', tab('all'), 150, 'touch');
  dispatch('pointerup', tab('all'), 150, 'touch');
  assert.strictEqual(app.state.chatTabOrder[0], 'system');
});

function touchChatHarness() {
  const harness = createHarness();
  const { app, document, timeouts } = harness;
  app.setActiveChatFilter('all');
  app.bindChatTabDrag();
  const tabs = document.querySelector('.tabs');
  tabs.scrollLeft = 0;
  tabs.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 40 });
  const tab = key => [...tabs.children].find(item => item.dataset.filter === key);
  let hovered = tab('system');
  document.elementFromPoint = () => hovered ? { closest: () => hovered } : null;
  const fire = (type, options = {}) => {
    let prevented = false;
    const touch = { identifier: 7, clientX: options.x ?? 120, clientY: 20 };
    const event = {
      touches: options.multi ? [touch, { ...touch, identifier: 8 }] : type === 'touchend' ? [] : [touch],
      changedTouches: [touch], cancelable: options.cancelable !== false,
      target: { closest: selector => selector === '.tab' ? tab('system') : options.close ? tab('system') : null },
      preventDefault() { prevented = true; }, stopImmediatePropagation() {},
    };
    (tabs.listeners.get(type) || []).forEach(listener => listener(event));
    return prevented;
  };
  const timer = delay => {
    const entry = [...timeouts].find(([, value]) => value.delay === delay);
    assert(entry, `Expected a ${delay}ms timer`);
    timeouts.delete(entry[0]);
    entry[1].callback();
  };
  return { ...harness, tabs, tab, fire, timer, hover: key => { hovered = key ? tab(key) : null; } };
}

test('touch hold arms dragging, survives live arrivals, scrolls at edges and suppresses selection', () => {
  const { app, tabs, tab, fire, timer, hover, timeouts } = touchChatHarness();
  assert.strictEqual(fire('touchstart'), false, 'ordinary taps/scroll must remain native');
  timer(400);
  assert.strictEqual(app.state.draggedChatTab, 'system');
  const touched = tab('system');
  assert(touched.classList.contains('dragging'));
  app.addMessage({ kind: 'message', type: 'private', sender: 'NEW_TWR', text: 'Hello', messageId: 'during-touch' });
  assert.strictEqual(tab('system'), touched, 'live traffic must not replace the touched DOM node');
  assert(app.state.chatTabsNeedRender);
  hover('all');
  assert.strictEqual(fire('touchmove', { x: 15 }), true);
  assert(tab('all').classList.contains('drag-before'));
  const scroll = tabs.scrollLeft;
  timer(50);
  assert(tabs.scrollLeft < scroll, 'edge scroll continues without another move event');
  assert.strictEqual(fire('touchend'), true);
  assert.strictEqual(app.state.chatTabOrder[0], 'system');
  assert.strictEqual(app.state.filter, 'all');
  assert.strictEqual(app.state.chatTabGestureActive, false);
  assert.strictEqual(app.state.chatTabsNeedRender, false);
  assert(tabs.children.some(item => item.dataset.peer === 'NEW_TWR'));
  assert(![...timeouts.values()].some(item => item.delay === 50 || item.delay === 400));
  assert.strictEqual(fire('click'), true, 'release must not select a different chat');
});

test('quick touch, early scrolling, X and multitouch never reorder or block scrolling', () => {
  for (const mode of ['tap', 'swipe', 'close', 'multi']) {
    const { app, fire, timeouts } = touchChatHarness();
    assert.strictEqual(fire('touchstart', { close: mode === 'close', multi: mode === 'multi' }), false);
    if (mode === 'swipe') assert.strictEqual(fire('touchmove', { x: 160 }), false);
    assert.strictEqual(fire('touchend'), false);
    assert.strictEqual(app.state.chatTabOrder[0], 'all');
    assert.strictEqual(app.state.chatTabGestureActive, false);
    assert(![...timeouts.values()].some(item => item.delay === 400));
  }
});

test('touch cancellation, multi-finger gestures, outside release and standby cancel safely', async () => {
  for (const mode of ['cancel', 'multi', 'outside', 'standby', 'uncancelable', 'scope']) {
    const { app, fire, timer, hover, document, timeouts } = touchChatHarness();
    fire('touchstart');
    timer(400);
    hover('all');
    fire('touchmove', { x: 160 });
    if (mode === 'cancel') fire('touchcancel');
    if (mode === 'multi') fire('touchmove', { multi: true });
    if (mode === 'outside') { hover(null); fire('touchmove', { x: 400 }); }
    if (mode === 'standby') { document.hidden = true; await document.dispatch('visibilitychange'); }
    if (mode === 'uncancelable') fire('touchmove', { cancelable: false });
    if (mode === 'scope') { app.state.chatLayoutScope = 'changed'; fire('touchmove'); }
    fire('touchend');
    assert.strictEqual(app.state.chatTabOrder[0], 'all', mode);
    assert.strictEqual(app.state.chatTabGestureActive, false, mode);
    assert(![...timeouts.values()].some(item => item.delay === 50 || item.delay === 400), mode);
  }
});

test('weather requests reuse METAR/TAF tabs and late replies never steal selection', () => {
  const { app, input, document } = draftHarness();
  app.state.callsign = 'TEST123';
  input.value = '.metar LIMC';
  app.submitMessage();
  assert.strictEqual(app.state.privatePeer, 'METAR');
  assert.strictEqual(document.getElementById('recipient').options[0].textContent, 'Weather: METAR');
  app.addMessage({ kind: 'message', type: 'system', sender: 'METAR', recipient: 'TEST123', text: 'LIMC 171200Z 00000KT CAVOK 20/10 Q1013', messageId: 'wx-old' });
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 1);
  app.reorderChatTab('private:METAR', 'all');
  app.closePrivateChat('METAR');
  input.value = '.wx LIRF';
  app.submitMessage();
  assert.strictEqual(app.state.privatePeer, 'METAR');
  assert.strictEqual(app.state.chatTabOrder[0], 'private:METAR');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 1, 'request must not clear retained reports');
  app.closePrivateChat('METAR');
  app.openPrivateChat('TEST_TWR');
  input.value = 'Tower draft';
  app.addMessage({ kind: 'message', type: 'system', sender: 'METAR', recipient: 'TEST123', text: 'LIRF 171230Z 00000KT CAVOK 20/10 Q1013', messageId: 'wx-new' });
  assert(!app.state.privatePeers.get('METAR').hidden);
  assert.strictEqual(app.state.privatePeers.get('METAR').unread, 1);
  assert.strictEqual(app.state.privatePeer, 'TEST_TWR');
  assert.strictEqual(input.value, 'Tower draft');
  app.openPrivateChat('METAR');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 2);
  input.value = '.taf LIMC';
  app.submitMessage();
  assert.strictEqual(app.state.privatePeer, 'TAF');
  assert.strictEqual(app.state.chatTabOrder.filter(key => key === 'private:METAR').length, 1);
  app.addRemoteChatMessage({ sender: 'TAF', recipient: 'TEST123', direction: 'incoming', text: 'TAF LIMC 171100Z 1712/1812 00000KT CAVOK', messageId: 'taf' });
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 1);
  assert.strictEqual(app.state.messages.at(-1).type, 'system', 'remote weather must match local classification');
  app.setActiveChatFilter('for-you');
  assert.strictEqual(app.state.messages.filter(app.messageMatchesCurrentTab).length, 0);
});

test('failed weather requests retain draft/selection and weather tabs cannot send ordinary chat', () => {
  const { app, input } = draftHarness();
  input.value = '.metar INVALID';
  app.submitMessage();
  assert.strictEqual(app.state.filter, 'all');
  assert.strictEqual(app.state.ws.sent.length, 0);
  assert.strictEqual(input.value, '.metar INVALID');
  app.state.ws.readyState = FakeWebSocket.CLOSED;
  input.value = '.taf LIMC';
  app.submitMessage();
  assert.strictEqual(input.value, '.taf LIMC');
  assert(!app.state.privatePeers.has('TAF'));
  app.state.ws.readyState = FakeWebSocket.OPEN;
  app.submitMessage();
  input.value = 'Do not send this to the weather service';
  app.submitMessage();
  assert.strictEqual(app.state.ws.sent.length, 1);
  assert.strictEqual(input.value, 'Do not send this to the weather service');
});

test('remote weather history respects saved hiding and route weather stays in its panel', () => {
  const { app } = draftHarness();
  const report = { sender: 'METAR', recipient: 'TEST123', direction: 'incoming', text: 'LIMC 171200Z 00000KT CAVOK 20/10 Q1013', messageId: 'remote-wx', timestamp: '2026-09-17T12:00:00Z' };
  app.handleRemoteRelayMessage(remoteEnvelope(app.REMOTE_MESSAGE_TYPES.CHAT_HISTORY, { messages: [report] }));
  app.closePrivateChat('METAR');
  app.handleRemoteRelayMessage(remoteEnvelope(app.REMOTE_MESSAGE_TYPES.CHAT_HISTORY, { messages: [report] }));
  assert(app.state.privatePeers.get('METAR').hidden);
  const oldFilter = app.state.filter;
  app.applyRemoteWeatherState({ flightPlanStatus: 'filed', weatherState: { departure: { icao: 'LIMC', metar: { text: report.text, receivedAt: report.timestamp } } } });
  assert.strictEqual(app.state.filter, oldFilter);
  assert(app.state.privatePeers.get('METAR').hidden);
});

test('addressed-message highlighting matches the public Push prefix rule', () => {
  const { app } = createHarness();
  app.state.callsign = 'RYR12';
  for (const text of ['RYR12', 'RYR12, Contact tower', '  ryr12 switch to UNICOM',
    'RYR12: hello', 'RYR12; hello', 'RYR12\thello', 'RYR123, hello',
    'Hello RYR12', 'RYR12_APP hello', 'RYR12-hello', '', '<b>RYR12</b>']) {
    for (const type of ['frequency', 'broadcast', 'private', 'system']) {
      for (const direction of ['incoming', 'outgoing']) {
        const message = { kind: 'message', type, direction, text, sender: 'TEST_TWR', recipient: '@22800' };
        assert.strictEqual(app.isMessageAddressedToMe(message),
          notificationTrigger(message, app.state.callsign) === 'addressed', `${type}/${direction}: ${text}`);
      }
    }
  }
  app.state.callsign = '';
  assert.strictEqual(app.isMessageAddressedToMe({ type: 'frequency', text: 'Anything' }), false);
});

test('highlighted chat stays filtered, escaped and independent of Push permissions', () => {
  const { app, document } = createHarness();
  app.state.callsign = 'RYR12';
  app.state.comFrequencies[1] = '122.800';
  const publicMessage = { kind: 'message', type: 'frequency', sender: 'TEST_TWR',
    direction: 'incoming', recipient: '@22800', text: 'RYR12, <script>alert(1)</script>' };
  app.addMessage({ ...publicMessage, messageId: 'addressed' });
  app.addMessage({ ...publicMessage, messageId: 'other', text: 'RYR123, Contact tower' });
  app.addMessage({ ...publicMessage, messageId: 'untuned', recipient: '@26805' });
  app.addMessage({ ...publicMessage, messageId: 'private', type: 'private', recipient: 'RYR12' });
  const box = document.getElementById('messages');
  const addressed = box.children.find(row => row.dataset.chatMessageId === 'addressed');
  assert(addressed.classList.contains('addressed'));
  assert.match(addressed.innerHTML, /For you/);
  assert.match(addressed.innerHTML, /&lt;script&gt;/);
  assert(!addressed.innerHTML.includes('<script>'));
  assert.strictEqual(box.children.filter(row => row.classList.contains('addressed')).length, 1);
  assert(!box.children.some(row => row.dataset.chatMessageId === 'untuned'));
  app.setActiveChatFilter('frequency');
  assert.strictEqual(box.children.filter(row => row.classList.contains('addressed')).length, 1);
  app.handleMessage({ kind: 'status', connected: true, callsign: 'RYR123' });
  assert.deepStrictEqual(box.children.filter(row => row.classList.contains('addressed'))
    .map(row => row.dataset.chatMessageId), ['other']);
});

test('For you combines received private and addressed public messages without changing drafts', () => {
  const { app, document, input } = draftHarness();
  app.state.callsign = 'RYR12';
  app.state.comFrequencies[1] = '122.800';
  const messages = [
    { messageId: 'private-in', type: 'private', recipient: 'RYR12', text: 'Hello' },
    { messageId: 'private-out', type: 'private', recipient: 'TEST_TWR', text: 'Reply', direction: 'outgoing', sender: 'RYR12' },
    { messageId: 'addressed', type: 'frequency', recipient: '@22800', text: 'RYR12, contact tower' },
    { messageId: 'broadcast', type: 'broadcast', recipient: '*', text: 'RYR12, hello' },
    { messageId: 'other', type: 'frequency', recipient: '@22800', text: 'RYR123, contact tower' },
    { messageId: 'untuned', type: 'frequency', recipient: '@26805', text: 'RYR12, hello' },
    { messageId: 'sent-public', type: 'frequency', recipient: '@22800', text: 'RYR12, hello', direction: 'outgoing' },
    { messageId: 'system', type: 'system', text: 'RYR12, weather requested' },
  ];
  messages.forEach(message => app.addMessage({ kind: 'message', direction: 'incoming', sender: 'TEST_TWR', ...message }));
  input.value = 'Unsent UNICOM report';
  app.setActiveChatFilter('for-you');
  const box = document.getElementById('messages');
  const visible = () => box.children.map(row => row.dataset.chatMessageId);
  assert.deepStrictEqual(visible(), ['private-in', 'addressed', 'broadcast']);
  assert.strictEqual(input.value, 'Unsent UNICOM report');
  assert.strictEqual(document.getElementById('recipient').value, '@22800');
  app.openPrivateChat('TEST_TWR');
  assert.deepStrictEqual(visible(), ['private-in', 'private-out']);
  input.value = 'Private draft';
  app.closePrivateChat('TEST_TWR');
  assert.strictEqual(app.state.filter, 'for-you');
  assert.deepStrictEqual(visible(), ['private-in', 'addressed', 'broadcast']);
  assert.strictEqual(input.value, 'Unsent UNICOM report');
  app.handleMessage({ kind: 'status', connected: true, callsign: 'RYR123' });
  assert.deepStrictEqual(visible(), ['private-in', 'other']);
  app.setActiveChatFilter('all');
  assert.strictEqual(app.state.messages.length, messages.length);
  assert(visible().includes('private-out'));
});

test('remote history gains highlighting when the active callsign becomes known', () => {
  const { app, document } = createHarness();
  const history = remoteEnvelope(app.REMOTE_MESSAGE_TYPES.CHAT_HISTORY, { messages: [{
    sender: 'TEST_TWR', recipient: '*', text: 'RYR12, switch to UNICOM', messageId: 'replayed', direction: 'incoming',
  }] });
  app.handleRemoteRelayMessage(history);
  const box = document.getElementById('messages');
  assert(!box.children[0].classList.contains('addressed'));
  app.handleRemoteRelayMessage(remoteEnvelope(app.REMOTE_MESSAGE_TYPES.AGENT_STATUS,
    { connected: true, callsign: 'RYR12' }));
  assert(box.children[0].classList.contains('addressed'));
  app.handleRemoteRelayMessage(history);
  assert.strictEqual(box.children.length, 1);
  app.setActiveChatFilter('for-you');
  assert.strictEqual(box.children.length, 1, 'recovered addressed messages belong to For you');
});

function draftHarness(options) {
  const harness = createHarness(options);
  const { app, document } = harness;
  app.state.connected = true;
  app.state.ws = new FakeWebSocket();
  app.state.ws.readyState = FakeWebSocket.OPEN;
  app.updateComposerContext();
  return { ...harness, input: document.getElementById('message-input') };
}

test('drafts follow recipients rather than chat filters, history or COM updates', () => {
  const { app, input } = draftHarness();
  input.value = '  Traffic report in progress  ';
  for (const filter of ['frequency', 'for-you', 'system', 'all']) {
    app.setActiveChatFilter(filter);
    assert.strictEqual(input.value, '  Traffic report in progress  ');
  }
  app.setComLabel(1, '126.805');
  app.addMessage({ kind: 'message', type: 'system', text: 'An incoming update' });
  assert.strictEqual(input.value, '  Traffic report in progress  ');
  app.openPrivateChat('EPRZ_TWR');
  assert.strictEqual(input.value, '');
  input.value = 'Tower draft';
  app.openPrivateChat('EDGG_CTR');
  assert.strictEqual(input.value, '');
  input.value = 'Center draft';
  app.openPrivateChat('eprz_twr');
  assert.strictEqual(input.value, 'Tower draft');
  app.closePrivateChat('EDGG_CTR');
  assert.strictEqual(input.value, 'Tower draft', 'closing another tab keeps the active draft');
  app.closePrivateChat('EPRZ_TWR');
  assert.strictEqual(input.value, '  Traffic report in progress  ');
  app.openPrivateChat('EDGG_CTR');
  assert.strictEqual(input.value, 'Center draft', 'closing a tab must preserve its draft');
  app.openPrivateChat('EPRZ_TWR');
  assert.strictEqual(input.value, 'Tower draft');
});

test('submitting clears only the submitted draft, without resending on return', () => {
  const { app, input } = draftHarness();
  input.value = 'UNICOM draft';
  app.openPrivateChat('EPRZ_TWR');
  input.value = '  Tower message  ';
  app.submitMessage();
  assert.strictEqual(input.value, '');
  assert.deepStrictEqual(JSON.parse(app.state.ws.sent[0]), {
    action: 'send_message', recipient: 'EPRZ_TWR', text: 'Tower message',
  });
  app.setActiveChatFilter('all');
  assert.strictEqual(input.value, 'UNICOM draft');
  app.openPrivateChat('EPRZ_TWR');
  assert.strictEqual(input.value, '');
  assert.strictEqual(app.state.ws.sent.length, 1);
});

test('unavailable or throwing transport retains ordinary and direct-command drafts', () => {
  const { app, input } = draftHarness();
  const socket = app.state.ws;
  for (const text of ['Traffic report', '.m EPRZ_TWR hello', '.chat EPRZ_TWR hello']) {
    input.value = text;
    app.state.connected = false;
    app.submitMessage();
    assert.strictEqual(input.value, text);
    app.state.connected = true;
    socket.readyState = FakeWebSocket.CLOSED;
    app.submitMessage();
    assert.strictEqual(input.value, text);
    socket.readyState = FakeWebSocket.OPEN;
    socket.send = () => { throw new Error('Connection lost'); };
    app.submitMessage();
    assert.strictEqual(input.value, text);
    assert.strictEqual(app.state.filter, 'all');
  }
  socket.send = FakeWebSocket.prototype.send;
  input.value = 'Retry once';
  app.submitMessage();
  assert.strictEqual(input.value, '');
  assert.strictEqual(socket.sent.length, 1);
});

test('.chat switches to the destination draft without clearing it', () => {
  for (const command of ['.chat EPRZ_TWR', '.chat EPRZ_TWR hello']) {
    const { app, input } = draftHarness();
    app.openPrivateChat('EPRZ_TWR');
    input.value = 'Existing tower draft';
    app.setActiveChatFilter('all');
    input.value = command;
    app.submitMessage();
    assert.strictEqual(app.state.privatePeer, 'EPRZ_TWR');
    assert.strictEqual(input.value, 'Existing tower draft');
    app.setActiveChatFilter('all');
    assert.strictEqual(input.value, '', 'the executed command must not return as a draft');
    assert.strictEqual(app.state.ws.sent.length, command.endsWith(' hello') ? 1 : 0);
  }
});

test('public recipient modes have separate drafts and Custom cancellation never sends', () => {
  const { app, input, document } = draftHarness();
  const select = document.getElementById('recipient');
  const choose = value => {
    select.value = value;
    app.state.chatRecipient = value;
    app.syncComposerDraft();
  };
  input.value = 'UNICOM draft';
  choose('*');
  assert.strictEqual(input.value, '');
  input.value = 'Broadcast draft';
  app.openPrivateChat('EPRZ_TWR');
  input.value = 'Private draft';
  app.setActiveChatFilter('all');
  assert.strictEqual(select.value, '*');
  assert.strictEqual(input.value, 'Broadcast draft');
  choose('custom');
  input.value = 'Custom draft';
  app.submitMessage();
  assert.strictEqual(input.value, 'Custom draft');
  assert.strictEqual(app.state.ws.sent.length, 0);
  choose('@22800');
  assert.strictEqual(input.value, 'UNICOM draft');
  choose('custom');
  assert.strictEqual(input.value, 'Custom draft');
});

test('drafts remain isolated between remote agents and account identities', () => {
  const { app, input } = draftHarness();
  app.state.remote.enabled = true;
  app.state.remoteIdentity.userId = 'user-a';
  app.selectRemoteDevice('agent-a');
  input.value = 'Agent A draft';
  app.selectRemoteDevice('agent-b');
  assert.strictEqual(input.value, '');
  input.value = 'Agent B draft';
  app.selectRemoteDevice('agent-a');
  assert.strictEqual(input.value, 'Agent A draft');
  app.state.remoteSelectedDeviceId = '';
  app.selectRemoteDevice('agent-a');
  assert.strictEqual(input.value, 'Agent A draft', 'reconnecting the same agent keeps its draft');
  app.state.remoteIdentity.userId = 'user-b';
  const sentBefore = app.state.ws.sent.length;
  app.submitMessage();
  assert.strictEqual(input.value, '', 'a stale context must not submit another user\'s draft');
  assert.strictEqual(app.state.ws.sent.length, sentBefore);
  app.state.remoteIdentity.userId = 'user-a';
  app.syncComposerDraft();
  assert.strictEqual(input.value, 'Agent A draft');
});

test('deleted drafts stay deleted and new documents do not restore drafts from storage', () => {
  const { app, input, storage } = draftHarness();
  input.value = 'Private unsent text';
  app.openPrivateChat('EPRZ_TWR');
  app.setActiveChatFilter('all');
  input.value = '';
  app.openPrivateChat('EPRZ_TWR');
  app.setActiveChatFilter('all');
  assert.strictEqual(input.value, '');
  assert(!JSON.stringify([...storage.entries()]).includes('Private unsent text'));
  assert.strictEqual(draftHarness().input.value, '');
});

test('chat follows the bottom but preserves a scrolled reading position', () => {
  const { app, document } = createHarness();
  const box = document.getElementById('messages');
  const add = index => app.addMessage({
    kind: 'message', type: 'system', messageId: `scroll-${index}`, text: `Message ${index}`,
  });
  for (let i = 0; i < 20; i += 1) add(i);
  assert.strictEqual(box.scrollTop, box.scrollHeight - box.clientHeight, 'initial history opens at bottom');
  box.scrollTop = 135;
  const anchorId = box.children[3].dataset.chatMessageId;
  const top = box.children[3].getBoundingClientRect().top;
  add(20);
  assert.strictEqual(box.scrollTop, 135);
  assert.strictEqual(box.children.find(row => row.dataset.chatMessageId === anchorId).getBoundingClientRect().top, top);

  // An unchanged COM update also re-renders chat and must not reset reading.
  app.setComLabel(1, '122.800');
  assert.strictEqual(box.scrollTop, 135);
  box.scrollTop = box.scrollHeight - box.clientHeight - 10;
  add(21);
  assert.strictEqual(box.scrollTop, box.scrollHeight - box.clientHeight, 'near-bottom follows new traffic');
});

test('chat keeps its message anchor when bounded history drops old rows', () => {
  const { app, document } = createHarness();
  app.state.messages = Array.from({ length: 400 }, (_, index) => ({
    kind: 'message', type: 'system', messageId: `bounded-${index}`, text: `Message ${index}`,
  }));
  app.setActiveChatFilter('all');
  const box = document.getElementById('messages');
  box.scrollTop = 215;
  const anchor = box.children[5];
  const offset = anchor.getBoundingClientRect().top;
  app.addMessage({ kind: 'message', type: 'system', messageId: 'new', text: 'New message' });
  assert.strictEqual(app.state.messages.length, 400);
  assert.strictEqual(box.scrollTop, 175, 'scroll compensates for removed first row');
  assert.strictEqual(box.children.find(row => row.dataset.chatMessageId === anchor.dataset.chatMessageId).getBoundingClientRect().top, offset);
});

test('chat preserves surviving rows after removals and clamps an empty view', () => {
  const { app, document } = createHarness();
  app.state.messages = Array.from({ length: 20 }, (_, index) => ({
    kind: 'message', type: 'system', messageId: `removed-${index}`, text: `Message ${index}`,
  }));
  app.setActiveChatFilter('all');
  const box = document.getElementById('messages');
  box.scrollTop = 215;
  const nextRowId = box.children[6].dataset.chatMessageId;
  const nextRowTop = box.children[6].getBoundingClientRect().top;
  // Simulate expiry above the viewport and removal of the first visible row.
  app.state.messages = app.state.messages.filter((_, index) => index !== 0 && index !== 5);
  app.setComLabel(1, '122.800');
  assert.strictEqual(box.children.find(row => row.dataset.chatMessageId === nextRowId).getBoundingClientRect().top, nextRowTop);
  app.state.messages = [];
  app.setComLabel(1, '122.800');
  assert.strictEqual(box.scrollTop, 0);
  assert.match(box.innerHTML, /No messages/);
});

test('chat filtering preserves reading unless a different tab is selected', () => {
  const { app, document } = createHarness();
  app.state.messages = Array.from({ length: 30 }, (_, index) => ({
    kind: 'message', type: index % 2 ? 'private' : 'system',
    messageId: `filter-${index}`, privatePeer: 'TEST_TWR', text: `Message ${index}`,
  }));
  app.setActiveChatFilter('all');
  const box = document.getElementById('messages');
  box.scrollTop = 100;
  app.setActiveChatFilter('system');
  assert.strictEqual(box.scrollTop, box.scrollHeight - box.clientHeight);
  box.scrollTop = 100;
  app.addMessage({ kind: 'message', type: 'private', sender: 'OTHER_TWR', messageId: 'hidden', text: 'Hidden' });
  assert.strictEqual(box.scrollTop, 100, 'filtered-out traffic must not move the viewport');
  app.setActiveChatFilter('system');
  assert.strictEqual(box.scrollTop, 100, 'clicking the same tab preserves reading');
  app.setActiveChatFilter('private-peer', 'TEST_TWR');
  assert.strictEqual(box.scrollTop, box.scrollHeight - box.clientHeight);
  box.scrollTop = 100;
  app.closePrivateChat('TEST_TWR');
  assert.strictEqual(box.scrollTop, box.scrollHeight - box.clientHeight, 'closing the active peer opens For you at bottom');
  assert.strictEqual(app.state.messages.length, 31);
  app.setActiveChatFilter('frequency');
  app.addMessage({ kind: 'message', type: 'frequency', messageId: 'first-frequency', text: 'First' });
  assert.strictEqual(box.scrollTop, 0, 'empty and short views stay at the top');
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

test('RX mute stops queued playback, drops muted PCM and leaves TX and notifications alone', async () => {
  const { app, document } = createHarness();
  const pcm = new Int16Array(160).buffer;
  app.state.tx = { ctx: { state: 'running' } };
  app.state.txReady = true;
  const tx = app.state.tx;
  const notifications = JSON.stringify(app.state.notifications);
  await app.handleIncomingPcm(pcm);
  const ctx = app.state.audioCtx;
  assert.strictEqual(ctx.sources.length, 1);
  app.toggleRxMute();
  assert.strictEqual(app.state.rxMuted, true);
  assert.strictEqual(ctx.sources[0].stopped, true);
  assert.strictEqual(ctx.sources[0].disconnected, true);
  assert.strictEqual(app.state.rxSources.size, 0);
  assert.strictEqual(ctx.state, 'running', 'mute must not suspend the RX context');
  assert.strictEqual(document.getElementById('rx-mute').getAttribute('aria-label'), 'Unmute web RX audio');
  assert.match(document.getElementById('rx-mute').title, /^Unmute web RX audio/);
  assert.strictEqual(document.getElementById('rx-mute').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(document.getElementById('rx-caption').textContent, 'Muted');
  await app.handleIncomingPcm(pcm);
  await app.playBrowserTestTone();
  assert.strictEqual(ctx.sources.length, 1, 'muted frames and test tones must not queue');
  assert(document.getElementById('rx-light').classList.contains('active'), 'RX activity remains visible');
  assert.strictEqual(app.state.tx, tx);
  assert.strictEqual(app.state.txReady, true);
  assert.strictEqual(JSON.stringify(app.state.notifications), notifications);
  app.toggleRxMute();
  await app.handleIncomingPcm(pcm);
  assert.strictEqual(ctx.sources.length, 2, 'only fresh audio starts on unmute');
  assert.strictEqual(document.getElementById('rx-mute').getAttribute('aria-label'), 'Mute web RX audio');
  ctx.sources[1].onended();
  assert.strictEqual(app.state.rxSources.size, 0, 'finished sources are released');
  assert.strictEqual(createHarness().app.state.rxMuted, false, 'new pages default to audible RX');
});

test('mute before activation and a mute/unmute during resume cannot replay old PCM', async () => {
  const { app } = createHarness();
  const pcm = new Int16Array(160).buffer;
  app.toggleRxMute();
  await app.handleIncomingPcm(pcm);
  assert.strictEqual(app.state.audioCtx, null);
  app.toggleRxMute();
  await app.handleIncomingPcm(pcm);
  const ctx = app.state.audioCtx;
  ctx.state = 'interrupted';
  let resume;
  ctx.resume = () => new Promise(resolve => { resume = () => { ctx.state = 'running'; resolve(); }; });
  const old = app.playPcm(pcm);
  const resolveOld = resume;
  app.toggleRxMute();
  app.toggleRxMute();
  resume();
  resolveOld();
  await old;
  assert.strictEqual(ctx.sources.length, 1, 'pre-mute pending audio must be discarded even after unmute');
  ctx.state = 'closed';
  app.toggleRxMute();
  app.toggleRxMute();
  await app.handleIncomingPcm(pcm);
  assert.notStrictEqual(app.state.audioCtx, ctx);
  assert.strictEqual(app.state.audioCtx.sources.length, 1);
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
