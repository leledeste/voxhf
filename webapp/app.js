const XPDR_STORAGE_KEY = 'voxhf.xpdrState.v1';
const REMOTE_STORAGE_KEY = 'voxhf.remoteSettings.v1';
const REMOTE_BROWSER_ID_STORAGE_KEY = 'voxhf.remoteBrowserId.v1';
const ACCOUNT_STORAGE_KEY = 'voxhf.accountSettings.v1';
const AUTH_MANUAL_STORAGE_KEY = 'voxhf.authManualMode.v1';
const UPDATE_NOTICE_STORAGE_KEY = 'voxhf.dismissedUpdate.v1';
const THEME_STORAGE_KEY = 'voxhf.theme.v1';
const PAGE_PARAMS = new URLSearchParams(location.search);
const DEMO_MODE = PAGE_PARAMS.get('demo') === '1';
const DEFAULT_XPDR_STATE = { squawk: '7000', mode: 'stby' };
const MAX_VISIBLE_STATION_DISTANCE_NM = 1200;
const WEATHER_REQUEST_TIMEOUT_MS = 20000;
const REMOTE_PROTOCOL_VERSION = 1;
const REMOTE_MESSAGE_TYPES = {
  PING: 'ping',
  PONG: 'pong',
  DEVICE_LIST: 'device.list',
  DEVICE_SELECT: 'device.select',
  DEVICE_STATE: 'device.state',
  PAIRING_CONFIRM: 'pairing.confirm',
  PAIRING_REVOKE: 'pairing.revoke',
  PAIRING_REVOKED: 'pairing.revoked',
  RELAY_IDENTITY: 'relay.identity',
  RELAY_ERROR: 'relay.error',
  AGENT_STATUS: 'agent.status',
  RADIO_SET: 'radio.set',
  RADIO_STATE: 'radio.state',
  STATIONS_STATE: 'stations.state',
  WEATHER_STATE: 'weather.state',
  CHAT_SEND: 'chat.send',
  CHAT_MESSAGE: 'chat.message',
  WEATHER_REQUEST: 'weather.request',
  ATIS_REQUEST: 'atis.request',
  XPDR_SET_SQUAWK: 'xpdr.setSquawk',
  XPDR_SET_MODE: 'xpdr.setMode',
  XPDR_IDENT: 'xpdr.ident',
  TX_START: 'tx.start',
  TX_STOP: 'tx.stop',
  MONITOR_START: 'monitor.start',
  MONITOR_STOP: 'monitor.stop',
};

function loadThemePreference() {
  // Theme preference is browser-local so hosted and local sessions can use
  // different appearances without involving the relay or proxy.
  try {
    const requested = PAGE_PARAMS.get('theme');
    if (DEMO_MODE && (requested === 'light' || requested === 'dark')) return requested;
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (_) {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let activeTheme = loadThemePreference();

function applyTheme(theme) {
  activeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = activeTheme;
  const label = document.getElementById('theme-label');
  const button = document.getElementById('theme-toggle');
  const nextTheme = activeTheme === 'dark' ? 'Light' : 'Dark';
  if (label) label.textContent = nextTheme;
  if (button) button.setAttribute('aria-label', 'Switch to ' + nextTheme.toLowerCase() + ' theme');
}

function toggleTheme() {
  const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch (_) {}
  applyTheme(nextTheme);
}
function loadStoredXpdrState() {
  // The proxy does not yet receive reliable transponder feedback from
  // PilotUI, so browser storage preserves the last state requested here.
  try {
    const saved = JSON.parse(localStorage.getItem(XPDR_STORAGE_KEY) || '{}');
    const squawk = normalizeSquawk(saved.squawk);
    const mode = saved.mode === 'alt' ? 'alt' : 'stby';
    return {
      squawk: squawk.length === 4 ? squawk : DEFAULT_XPDR_STATE.squawk,
      mode,
    };
  } catch (_) {
    return { ...DEFAULT_XPDR_STATE };
  }
}

function readRemoteConfig() {
  // Remote mode is intentionally explicit. A hosted copy of this file can
  // point at a relay with URL parameters or saved browser settings. Public
  // HTTPS hosts default to remote mode because they cannot reach the local
  // proxy WebSocket at /ws.
  const params = new URLSearchParams(location.search);
  const saved = loadRemoteSettings();
  if (params.get('local') === '1') {
    return { enabled: false, relay: saved.relay || '', url: '', token: saved.token || '', deviceId: saved.deviceId || '', pairingCode: saved.pairingCode || '' };
  }
  const urlRelay = params.get('relay') || '';
  const urlToken = params.get('token') || '';
  const urlDevice = params.get('device') || '';
  const urlPairing = params.get('pair') || '';
  const enabled = params.get('remote') === '1' || Boolean(urlRelay) || shouldDefaultToRemoteMode(saved);
  if (!enabled) {
    return { enabled: false, relay: '', url: '', token: '', deviceId: '', pairingCode: '' };
  }

  const relay = urlRelay || saved.relay || defaultRemoteRelay();
  const token = urlToken || saved.token || '';
  const deviceId = urlDevice || saved.deviceId || '';
  const pairingCode = normalizePairingCode(urlPairing || saved.pairingCode || '');
  const url = buildRemoteWsUrl(relay, token, loadRemoteBrowserId());
  return {
    enabled: true,
    relay,
    url,
    token,
    deviceId,
    pairingCode,
  };
}

function shouldDefaultToRemoteMode(saved) {
  // A static hosted webapp has no local proxy next to it, so remote mode is
  // the useful default. Private/local hosts stay local unless the URL or
  // saved settings explicitly request remote mode.
  if (saved.enabled === true) return true;
  if (location.protocol !== 'https:') return false;
  const host = location.hostname.toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const privateIpv4 = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return !localHosts.has(host) && !privateIpv4;
}

function defaultRemoteRelay() {
  // Hosted self-installs commonly use app.voxhf.com and relay.voxhf.com.
  // This gives a new browser a useful default without embedding any secret.
  if (location.protocol !== 'https:') return '';
  const host = location.hostname.toLowerCase();
  if (!host.startsWith('app.')) return '';
  return `wss://relay.${host.slice(4)}`;
}

function loadRemoteSettings() {
  // Saved settings are local to this browser. They avoid putting relay
  // tokens in the address bar during repeated preview tests.
  try {
    const saved = JSON.parse(localStorage.getItem(REMOTE_STORAGE_KEY) || '{}');
    return {
      enabled: saved.enabled === true,
      relay: String(saved.relay || ''),
      token: String(saved.token || ''),
      deviceId: String(saved.deviceId || ''),
      pairingCode: normalizePairingCode(saved.pairingCode || ''),
    };
  } catch (_) {
    return { enabled: false, relay: '', token: '', deviceId: '', pairingCode: '' };
  }
}

function saveRemoteSettings(next) {
  localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify({
    enabled: next.enabled === true,
    relay: String(next.relay || ''),
    token: String(next.token || ''),
    deviceId: String(next.deviceId || ''),
    pairingCode: normalizePairingCode(next.pairingCode || ''),
  }));
}

function loadAuthManualPreference() {
  // Manual token mode is a deliberate fallback. Persist the choice so a
  // token-mode tester is not asked to log in after every refresh.
  return localStorage.getItem(AUTH_MANUAL_STORAGE_KEY) === '1';
}

function saveAuthManualPreference(enabled) {
  if (enabled) localStorage.setItem(AUTH_MANUAL_STORAGE_KEY, '1');
  else localStorage.removeItem(AUTH_MANUAL_STORAGE_KEY);
}

function loadRemoteBrowserId() {
  // The relay pairs this stable browser id with one agent. It is not an
  // account or secret; it only lets refreshes keep the pairing in memory.
  const existing = localStorage.getItem(REMOTE_BROWSER_ID_STORAGE_KEY);
  if (/^[A-Za-z0-9._:-]{8,160}$/.test(existing || '')) return existing;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = `browser-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  localStorage.setItem(REMOTE_BROWSER_ID_STORAGE_KEY, id);
  return id;
}

function buildRemoteWsUrl(value, token, browserId) {
  // Accept http(s) relay bases for convenience, then convert to ws(s). The
  // relay receives source=browser and either a token or a session cookie.
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    url.searchParams.set('source', 'browser');
    if (token) url.searchParams.set('token', token);
    else url.searchParams.delete('token');
    url.searchParams.set('browserId', browserId || loadRemoteBrowserId());
    return url.toString();
  } catch (_) {
    return '';
  }
}

function buildRemoteHealthUrl(value) {
  // The relay preflight checks the HTTP health endpoint that sits next to
  // the WebSocket endpoint. Accept ws(s) and http(s) input for convenience.
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function setRemoteCheck(status, detail = '') {
  state.remoteCheck = { status, detail };
  updateSettingsView();
}

function loadAccountSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '{}');
    return {
      userId: String(saved.userId || ''),
      userName: String(saved.userName || ''),
    };
  } catch (_) {
    return { userId: '', userName: '' };
  }
}

function saveAccountSettings(next) {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({
    userId: String(next.userId || ''),
    userName: String(next.userName || ''),
  }));
}

function remoteRelayDraft() {
  // Both the first-run auth screen and Settings can edit the relay base.
  // Prefer the visible draft, then fall back to saved state and hosted
  // app.voxhf.com -> relay.voxhf.com convention.
  return $('auth-remote-url')?.value.trim()
    || $('settings-remote-url')?.value.trim()
    || state.remote.relay
    || defaultRemoteRelay();
}

function applyRemoteRelayDraft(relay = remoteRelayDraft()) {
  if (!relay) return false;
  state.remote.enabled = true;
  state.remote.relay = relay;
  state.remote.url = buildRemoteWsUrl(relay, state.remote.token, state.remoteBrowserId);
  saveRemoteSettings({
    enabled: true,
    relay,
    token: state.remote.token,
    deviceId: state.remoteSelectedDeviceId,
    pairingCode: state.remote.pairingCode,
  });
  syncRemoteSettingsInputs(false);
  return true;
}

function buildRemoteApiUrl(pathname) {
  const relay = remoteRelayDraft();
  if (!relay) return '';
  try {
    const url = new URL(relay, location.href);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

async function accountRequest(pathname, options = {}) {
  const url = buildRemoteApiUrl(pathname);
  if (!url) throw new Error('Remote relay URL is required.');
  const response = await fetch(url, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.code = body.code || '';
    error.status = response.status;
    throw error;
  }
  return body;
}

async function refreshAccountStatus() {
  if (!state.remote.enabled && !state.remote.relay) return false;
  try {
    const body = await accountRequest('/account/api/status');
    state.account.statusKnown = true;
    state.account.registrationEnabled = Boolean(body.registrationEnabled);
    state.account.registrationRequiresInvite = body.registrationRequiresInvite !== false;
    state.account.authenticated = Boolean(body.authenticated && body.user);
    state.account.userId = body.user?.userId || state.account.userId || '';
    state.account.userName = body.user?.userName || body.user?.userId || state.account.userName || '';
    saveAccountSettings(state.account);
    if (state.account.authenticated) await refreshAccountSessions(false);
    else state.account.sessions = [];
    updateSettingsView();
    updateAuthGate();
    return true;
  } catch (err) {
    // A network failure is not proof that the cookie expired. Keep the user
    // in the workspace and let normal reconnect handling explain the outage.
    state.account.statusKnown = false;
    state.account.authenticated = false;
    if (err?.code === 'account_mode_unavailable') state.account.registrationEnabled = false;
    updateSettingsView();
    updateAuthGate();
    return false;
  }
}

async function runRemotePreflight() {
  // This is a browser-side sanity check for hosted use: configuration,
  // relay health, current WebSocket state, and pairing readability.
  const relay = $('settings-remote-url')?.value.trim() || state.remote.relay;
  const token = $('settings-remote-token')?.value.trim() || state.remote.token;
  const pairingCode = normalizePairingCode($('settings-remote-pairing')?.value || state.remote.pairingCode);
  if (!relay) {
    setRemoteCheck('Missing relay URL');
    return false;
  }
  if (!token && !state.account.authenticated) {
    setRemoteCheck('Missing relay token');
    return false;
  }

  const wsUrl = buildRemoteWsUrl(relay, token, loadRemoteBrowserId());
  const healthUrl = buildRemoteHealthUrl(relay);
  if (!wsUrl || !healthUrl) {
    setRemoteCheck('Invalid relay URL');
    return false;
  }

  setRemoteCheck('Checking relay...');
  try {
    const response = await fetch(healthUrl, { cache: 'no-store' });
    if (!response.ok) {
      setRemoteCheck(`Health failed (${response.status})`);
      return false;
    }
    const health = await response.json();
    if (!health.ok || health.service !== 'voxhf-relay') {
      setRemoteCheck('Unexpected health response');
      return false;
    }

    const socketOpen = state.remote.enabled && state.ws?.readyState === WebSocket.OPEN;
    const pairing = state.remoteSelectedDeviceId
      ? 'paired'
      : pairingCode
        ? 'code ready'
        : 'needs code';
    const connection = socketOpen ? 'WS connected' : 'WS not connected yet';
    setRemoteCheck(`OK: ${connection}, ${pairing}`);
    return true;
  } catch (err) {
    setRemoteCheck('Health blocked or unreachable', err.message || '');
    return false;
  }
}

function normalizePairingCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

function displayRemoteRelay() {
  if (!state.remote.relay) return '---';
  return state.remote.relay.replace(/([?&]token=)[^&]+/i, '$1***');
}

function selectedRemoteDeviceLabel() {
  if (!state.remoteSelectedDeviceId) return '---';
  const device = state.remoteDevices.get(state.remoteSelectedDeviceId);
  return device?.deviceName
    ? `${device.deviceName} (${state.remoteSelectedDeviceId})`
    : state.remoteSelectedDeviceId;
}

function remoteUserLabel() {
  const identity = state.remoteIdentity || {};
  if (!identity.userId && state.account.authenticated) {
    return state.account.userName && state.account.userName !== state.account.userId
      ? `${state.account.userName} (${state.account.userId})`
      : state.account.userId || 'Logged in';
  }
  if (!identity.userId) return '---';
  if (identity.userName && identity.userName !== identity.userId) {
    return `${identity.userName} (${identity.userId})`;
  }
  return identity.userId;
}

function remoteSummary() {
  // This condenses the remote state into one operator-facing line. The
  // detailed rows below remain useful for debugging, but this catches the
  // common valid-token/no-agent case at a glance.
  if (!state.remote.enabled) return { text: 'Local mode', tone: '' };
  const wsState = state.ws?.readyState;
  if (wsState === WebSocket.CONNECTING) return { text: 'Connecting to relay', tone: 'warning' };
  if (wsState !== WebSocket.OPEN) return { text: 'Relay disconnected', tone: 'bad' };
  if (!state.remoteIdentity?.userId) {
    return {
      text: state.account.authenticated ? 'Relay connected, verifying account' : 'Relay connected, verifying token',
      tone: 'warning',
    };
  }
  if (!state.remoteDevices.size) {
    return {
      text: state.account.authenticated ? 'Logged in, start local VoxHF agent' : 'Token valid, waiting for local agent',
      tone: 'warning',
    };
  }
  if (!state.remoteSelectedDeviceId) {
    return {
      text: state.account.authenticated ? 'Agent online, selecting it' : 'Agent online, enter pairing code',
      tone: 'warning',
    };
  }
  if (!state.remoteDevices.has(state.remoteSelectedDeviceId)) return { text: 'Paired agent offline', tone: 'warning' };
  return { text: `Ready: ${selectedRemoteDeviceLabel()}`, tone: 'good' };
}

function remoteAgentStatusText() {
  if (!state.remote.enabled) return 'Local mode';
  if (!state.remoteDevices.size) return 'Local VoxHF agent offline';
  if (!state.remoteSelectedDeviceId) return state.account.authenticated ? 'Selecting local agent' : 'Waiting for browser pairing';
  return state.remoteDevices.has(state.remoteSelectedDeviceId) ? 'Online' : 'Offline';
}

function remotePairingStatusText() {
  // Pairing is browser-specific: the relay remembers this browser id, not a
  // global user account. Keep the wording explicit so reconnects are clear.
  if (!state.remote.enabled) return 'Local mode';
  if (state.remoteSelectedDeviceId && state.remoteDevices.has(state.remoteSelectedDeviceId)) {
    return state.account.authenticated ? 'Account access online' : 'Paired and online';
  }
  if (state.remoteSelectedDeviceId) return 'Paired, agent offline';
  if (state.account.authenticated) return state.remoteDevices.size ? 'Account session, no pairing code needed' : 'Logged in, waiting for agent';
  if (state.remote.pairingCode) return 'Pairing code ready';
  if (state.ws?.readyState === WebSocket.OPEN) return 'Needs pairing code';
  return 'Waiting for relay';
}

function localRemotePairingText() {
  // Local mode can generate pairing codes because the local agent owns the
  // relay connection. Remote browsers can only consume those codes.
  const pairing = state.localRemotePairing;
  if (!pairing?.code) return '---';
  const expires = Date.parse(pairing.expiresAt || '');
  if (!Number.isFinite(expires)) return pairing.code;
  return `${pairing.code} until ${new Date(expires).toISOString().slice(11, 16)}Z`;
}

function applyLocalRemotePairing(pairing, showStatus) {
  const code = normalizePairingCode(pairing?.code || '');
  if (!code) return;
  state.localRemotePairing = {
    code,
    expiresAt: String(pairing.expiresAt || ''),
  };
  if (showStatus) setRemoteCheck('Pairing code renewed');
  updateSettingsView();
}

async function copyTextToClipboard(text) {
  // Clipboard API is available on HTTPS and localhost. The fallback keeps
  // local development usable on older browsers.
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!ok) throw new Error('Clipboard is unavailable');
  return true;
}

function remoteLastUpdateText() {
  if (!state.remoteLastUpdateAt) return 'Waiting';
  return `${Math.round((Date.now() - state.remoteLastUpdateAt) / 1000)}s ago`;
}

function markRemoteUpdate() {
  state.remoteLastUpdateAt = Date.now();
  updateSettingsView();
}

function applyRemoteSettings() {
  const relay = $('settings-remote-url').value.trim();
  const token = $('settings-remote-token').value.trim();
  const pairingCode = normalizePairingCode($('settings-remote-pairing').value);
  if (!relay || (!token && !state.account.authenticated)) {
    setRemoteCheck(!relay ? 'Missing relay URL' : 'Missing relay token');
    addErrorMessage(!relay ? 'Remote relay URL is required.' : 'Remote relay token is required unless you are logged in.');
    return;
  }

  if (token && !state.account.authenticated) {
    state.authOverlayDismissed = true;
    saveAuthManualPreference(true);
  }
  saveRemoteSettings({ enabled: true, relay, token, deviceId: state.remoteSelectedDeviceId, pairingCode });
  const params = new URLSearchParams(location.search);
  params.set('remote', '1');
  params.delete('local');
  params.delete('relay');
  params.delete('token');
  params.delete('device');
  params.delete('pair');
  location.search = params.toString();
}

function switchToLocalMode() {
  saveRemoteSettings({ enabled: false, relay: state.remote.relay, token: state.remote.token, deviceId: state.remoteSelectedDeviceId, pairingCode: '' });
  state.remote.enabled = false;
  state.remote.url = '';
  state.remoteDevices.clear();
  state.remoteSelectedDeviceId = '';
  state.remoteIdentity = { userId: '', userName: '' };
  updateSettingsView();
  const params = new URLSearchParams(location.search);
  params.set('local', '1');
  params.delete('remote');
  params.delete('relay');
  params.delete('token');
  params.delete('device');
  params.delete('pair');
  const query = params.toString();
  const nextUrl = `${location.pathname}${query ? `?${query}` : ''}`;
  if (`${location.pathname}${location.search}` === nextUrl) location.reload();
  else location.replace(nextUrl);
}

function accountErrorMessage(err, action) {
  // Server errors include a stable code; keep login generic so the hosted
  // relay does not help enumerate accounts.
  const fallback = action === 'register' ? 'Registration failed.' : 'Login failed.';
  switch (err?.code) {
    case 'account_mode_unavailable':
      return 'Hosted accounts are not enabled on this relay. Use Manual Relay Setup.';
    case 'registration_disabled':
      return 'Registration is disabled on this relay. Ask the relay admin to create or enable your account.';
    case 'invalid_invite':
      return 'The invitation code is invalid, expired, or has already been used.';
    case 'username_taken':
      return 'That username is already taken. Try another one or log in.';
    case 'invalid_username':
      return 'Use a 2-48 character username: letters, numbers, dot, underscore, or dash.';
    case 'invalid_display_name':
      return 'Display name must be 1-80 characters.';
    case 'invalid_password':
      return 'Password must be 10-256 characters.';
    case 'invalid_credentials':
      return 'Username or password is incorrect. If this is your first time, register an account.';
    case 'auth_rate_limited':
      return 'Too many attempts. Wait a few seconds and try again.';
    case 'not_authenticated':
      return 'Your session expired. Log in again.';
    default:
      return err?.message || fallback;
  }
}

async function registerAccount() {
  const body = readAccountForm(true);
  if (!body) return;
  if (state.account.registrationEnabled === false) {
    setAuthStatus('Registration is disabled on this relay. Log in or use Manual Relay Setup.', 'bad');
    return;
  }
  if (!applyRemoteRelayDraft()) {
    addErrorMessage('Remote relay URL is required.');
    setAuthStatus('Remote relay URL is required.', 'bad');
    return;
  }
  try {
    const result = await accountRequest('/account/api/register', { method: 'POST', body });
    applyAccountUser(result.user);
    showAgentToken(result.agentToken);
    setRemoteCheck('Account registered');
    setAuthStatus('Account created. Copy the agent token before continuing.', 'good');
    saveAuthManualPreference(false);
    addLocal('Account registered. Copy the agent token into config.json on the Altitude PC.');
  } catch (err) {
    const message = accountErrorMessage(err, 'register');
    setAuthStatus(message, 'bad');
    if (!err?.code) addErrorMessage(`Account registration failed: ${message}`);
  }
}

async function loginAccount() {
  const body = readAccountForm(false);
  if (!body) return;
  if (!applyRemoteRelayDraft()) {
    addErrorMessage('Remote relay URL is required.');
    setAuthStatus('Remote relay URL is required.', 'bad');
    return;
  }
  try {
    const result = await accountRequest('/account/api/login', { method: 'POST', body });
    applyAccountUser(result.user);
    hideAgentToken();
    setRemoteCheck('Account logged in');
    setAuthStatus('Logged in.', 'good');
    state.authOverlayDismissed = true;
    saveAuthManualPreference(false);
    hideAuthGate();
    addLocal(`Logged in as ${state.account.userName || state.account.userId}.`);
    connect(true);
  } catch (err) {
    const message = accountErrorMessage(err, 'login');
    setAuthStatus(message, 'bad');
    if (!err?.code) addErrorMessage(`Account login failed: ${message}`);
  }
}

async function logoutAccount() {
  try {
    await accountRequest('/account/api/logout', { method: 'POST' });
  } catch (_) {}
  state.account.authenticated = false;
  state.account.userId = '';
  state.account.userName = '';
  state.account.sessions = [];
  saveAccountSettings(state.account);
  renderAccountSessions();
  hideAgentToken();
  setRemoteCheck('Account logged out');
  state.authOverlayDismissed = false;
  saveAuthManualPreference(false);
  if (state.remote.enabled && location.protocol === 'https:') {
    openAccountPage();
    return;
  }
  updateAuthGate();
  connect(true);
}

async function rotateAccountAgentToken() {
  try {
    const result = await accountRequest('/account/api/agent-token/rotate', { method: 'POST' });
    showAgentToken(result.agentToken);
    setRemoteCheck('Agent token rotated');
    addLocal('Agent token rotated. Update config.json and restart VoxHF on the Altitude PC.');
  } catch (err) {
    addErrorMessage(`Agent token rotation failed: ${accountErrorMessage(err, 'login')}`);
  }
}

async function refreshAccountSessions(showStatus = true) {
  if (!state.account.authenticated) {
    state.account.sessions = [];
    renderAccountSessions();
    return;
  }
  try {
    const result = await accountRequest('/account/api/sessions');
    state.account.sessions = result.sessions || [];
    renderAccountSessions();
    if (showStatus) setAccountSecurityStatus('Sessions refreshed.', 'good');
  } catch (err) {
    if (showStatus) setAccountSecurityStatus(accountErrorMessage(err, 'login'), 'bad');
  }
}

function renderAccountSessions() {
  const list = $('settings-account-sessions');
  if (!list) return;
  list.replaceChildren();
  for (const session of state.account.sessions || []) {
    const row = document.createElement('div');
    row.className = 'account-session-row';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = session.current ? 'This browser' : 'Browser session';
    const detail = document.createElement('span');
    const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).toLocaleString() : 'Unknown activity';
    detail.textContent = `${lastSeen}${session.userAgent ? ` · ${session.userAgent}` : ''}`;
    copy.append(title, detail);
    row.append(copy);
    if (!session.current) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = 'Revoke';
      revoke.dataset.accountSessionId = session.sessionId;
      row.append(revoke);
    }
    list.append(row);
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'setting-value';
    empty.textContent = state.account.authenticated ? 'No active sessions.' : 'Log in to manage sessions.';
    list.append(empty);
  }
}

async function revokeAccountSession(sessionId) {
  try {
    await accountRequest(`/account/api/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' });
    setAccountSecurityStatus('Session revoked.', 'good');
    await refreshAccountSessions(false);
  } catch (err) {
    setAccountSecurityStatus(accountErrorMessage(err, 'login'), 'bad');
  }
}

async function revokeOtherAccountSessions() {
  if (!state.account.authenticated || !window.confirm('Log out every other browser session?')) return;
  try {
    const result = await accountRequest('/account/api/sessions/revoke-others', { method: 'POST' });
    setAccountSecurityStatus(`${result.count} other session${result.count === 1 ? '' : 's'} logged out.`, 'good');
    await refreshAccountSessions(false);
  } catch (err) {
    setAccountSecurityStatus(accountErrorMessage(err, 'login'), 'bad');
  }
}

async function changeAccountPassword(event) {
  event.preventDefault();
  const currentPassword = $('settings-account-current-password').value;
  const newPassword = $('settings-account-new-password').value;
  const confirmation = $('settings-account-confirm-password').value;
  if (newPassword.length < 10) return setAccountSecurityStatus('New password must be at least 10 characters.', 'bad');
  if (newPassword !== confirmation) return setAccountSecurityStatus('The new passwords do not match.', 'bad');
  try {
    const result = await accountRequest('/account/api/password/change', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    $('settings-account-password-form').reset();
    setAccountSecurityStatus(`Password changed. ${result.revokedSessions || 0} other session${result.revokedSessions === 1 ? '' : 's'} logged out.`, 'good');
    await refreshAccountSessions(false);
  } catch (err) {
    setAccountSecurityStatus(accountErrorMessage(err, 'login'), 'bad');
  }
}

function setAccountSecurityStatus(message, tone = '') {
  const output = $('settings-account-security-status');
  output.textContent = message || '';
  output.className = `auth-status${tone ? ` ${tone}` : ''}`;
}

function readAccountForm(includeDisplayName) {
  const userId = $('auth-account-user').value.trim().toLowerCase();
  const displayName = $('auth-account-name').value.trim() || userId;
  const password = $('auth-account-password').value;
  if (!/^[a-z0-9._-]{2,48}$/.test(userId)) {
    setAuthStatus('Use a 2-48 character username: letters, numbers, dot, underscore, or dash.', 'bad');
    return null;
  }
  if (!password) {
    setAuthStatus('Enter your password.', 'bad');
    return null;
  }
  if (includeDisplayName && password.length < 10) {
    setAuthStatus('Password must be at least 10 characters.', 'bad');
    return null;
  }
  const body = { userId, password };
  if (includeDisplayName) {
    body.displayName = displayName;
    if (state.account.registrationRequiresInvite) {
      const inviteCode = $('auth-account-invite').value.trim().toUpperCase();
      if (!inviteCode) {
        setAuthStatus('Enter the invitation code provided by the relay administrator.', 'bad');
        return null;
      }
      body.inviteCode = inviteCode;
    }
  }
  return body;
}

function applyAccountUser(user) {
  state.account.authenticated = true;
  state.account.userId = user?.userId || '';
  state.account.userName = user?.userName || user?.userId || '';
  saveAccountSettings(state.account);
  updateSettingsView();
}

function showAgentToken(token) {
  const text = `Agent token shown once:\n${token}\n\nPut it in config.json as remoteRelayToken, then restart VoxHF on the Altitude PC.`;
  for (const id of ['settings-account-token', 'auth-agent-token']) {
    const box = $(id);
    if (!box) continue;
    box.textContent = text;
    box.classList.remove('hidden');
  }
  $('auth-continue')?.classList.remove('hidden');
}

function hideAgentToken() {
  for (const id of ['settings-account-token', 'auth-agent-token']) {
    const box = $(id);
    if (!box) continue;
    box.textContent = '';
    box.classList.add('hidden');
  }
  $('auth-continue')?.classList.add('hidden');
}

const storedXpdrState = loadStoredXpdrState();
const remoteConfig = readRemoteConfig();
const remoteBrowserId = loadRemoteBrowserId();
const storedAccount = loadAccountSettings();

// All page state lives here so reconnects and UI rendering can stay
// predictable. The proxy remains the source of truth for network status.
const state = {
  ws: null,
  remote: remoteConfig,
  remoteBrowserId,
  remoteDevices: new Map(),
  remoteSelectedDeviceId: remoteConfig.deviceId,
  remoteSelectedOnCurrentSocket: '',
  remoteIdentity: { userId: '', userName: '' },
  account: {
    authenticated: false,
    statusKnown: false,
    userId: storedAccount.userId,
    userName: storedAccount.userName,
    registrationEnabled: null,
    registrationRequiresInvite: true,
    sessions: [],
  },
  authOverlayDismissed: loadAuthManualPreference(),
  localRemotePairing: null,
  remoteLastUpdateAt: 0,
  remoteCheck: { status: 'Not checked', detail: '' },
  remoteSetupPromptShown: false,
  generation: 0,
  connected: false,
  callsign: '',
  lanIp: '',
  version: '',
  updateCheckUrl: '',
  updatePolicy: {
    latestVersion: '',
    recommendedLocalVersion: '',
    minimumLocalVersion: '',
    downloadUrl: '',
    notesUrl: '',
    source: '',
  },
  voiceServer: '',
  micStatus: 'Not requested',
  flightPlanStatus: 'missing',
  flightPlan: { departure: '', destination: '', alternate: '' },
  weatherState: {
    departure: { icao: '', metar: null, taf: null },
    destination: { icao: '', metar: null, taf: null },
  },
  messages: [],
  weatherExpanded: new Set(),
  weatherPending: new Map(),
  filter: 'all',
  privatePeer: '',
  privatePeers: new Map(),
  stations: new Map(),
  ownPosition: null,
  comFrequencies: { 1: '', 2: '' },
  comStations: { 1: '', 2: '' },
  txSampleRate: 8000,
  audioCtx: null,
  nextAudioTime: 0,
  lastPcmAt: 0,
  audioUnlockBound: false,
  rxTimer: null,
  tx: null,
  txHoldActive: false,
  txStartSeq: 0,
  webTxEnabled: true,
  txReady: false,
  lastPongAt: 0,
  pongPendingSince: 0,
  connectStartedAt: 0,
  altitudeOfflineTimer: null,
  commandMatches: [],
  commandIndex: 0,
  commandQueryText: '',
  transientSeq: 0,
  activeSettingsTab: 'audio',
  squawk: storedXpdrState.squawk,
  xpdrMode: storedXpdrState.mode,
  identTimer: null,
};

// Tiny DOM/string helpers kept local to avoid a frontend build step.
const $ = id => document.getElementById(id);
const enc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// UI ids are grouped so global state changes, such as disconnect or TX
// active, can be applied consistently.
const CONTROL_IDS = ['send', 'com1-input', 'com2-input', 'com1-select', 'com2-select', 'tx1', 'tx2', 'settings-test-audio', 'settings-monitor-tx', 'xpdr-code', 'xpdr-stby', 'xpdr-alt', 'xpdr-ident'];
const TX_BUTTON_IDS = ['tx1', 'tx2'];

// Binary microphone frames are prefixed with CTX1 so the proxy can
// distinguish PCM from JSON commands on the same WebSocket.
const TX_PACKET_MAGIC = new Uint8Array([67, 84, 88, 49]); // "CTX1"
const RX_PCM_SAMPLE_RATE = 16000;
const TX_RELEASE_TAIL_MS = 300;

// Heartbeat detects a stale browser WebSocket after standby. Audio may keep
// playing, so recovery recreates only the control channel.
const HEARTBEAT_MS = 5000;
const PONG_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 10000;

// Browser-level processing helps make the web microphone acceptable before
// it reaches the Speex encoder.
const MIC_CONSTRAINTS = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

// Autocomplete shows one canonical spelling for each action. Short aliases
// remain accepted by runCommand() without cluttering the suggestion menu.
const COMMAND_SUGGESTIONS = [
  { name: '.metar', args: 'ICAO', description: 'Request METAR' },
  { name: '.taf', args: 'ICAO', description: 'Request TAF' },
  { name: '.atis', args: 'CALLSIGN', description: 'Request ATIS' },
  { name: '.chat', args: 'CALLSIGN [text]', description: 'Open private chat' },
  { name: '.c1', args: 'frequency', description: 'Tune COM1' },
  { name: '.c2', args: 'frequency', description: 'Tune COM2' },
  { name: '.x', args: 'code', description: 'Set squawk' },
  { name: '.xpdr', args: '', description: 'Toggle transponder' },
  { name: '.ident', args: '', description: 'Send IDENT' },
];

// UNICOM is not discovered from ATC position packets, but it should always
// be available as a normal radio tuning target.
const UNICOM_STATION = { callsign: 'UNICOM', freq: '122.800', isUnicom: true };

function connect(force = false) {
  // Local mode talks to the proxy at /ws. Remote mode talks to the relay.
  if (state.remote.enabled) return connectRemote(force);
  return connectLocal(force);
}

// WebSocket is the only live channel between the page and the Node proxy.
function connectLocal(force = false) {
  if (!force && state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  // generation prevents late events from an old socket from modifying the
  // current UI after automatic recovery or browser reconnect.
  const generation = ++state.generation;
  if (state.ws && state.ws.readyState < 2) state.ws.close();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.binaryType = 'arraybuffer';
  state.connectStartedAt = Date.now();

  state.ws.onopen = () => {
    if (generation !== state.generation) return;
    state.connectStartedAt = 0;
    state.lastPongAt = Date.now();
    state.pongPendingSince = 0;
    send({ action: 'ping', at: state.lastPongAt });
  };

  state.ws.onclose = () => {
    if (generation !== state.generation) return;
    state.connectStartedAt = 0;
    setOffline('Proxy unavailable', 'Start start.bat or node proxy.js.');
    setTimeout(connect, 2500);
  };

  state.ws.onerror = () => {};

  state.ws.onmessage = event => {
    if (generation !== state.generation) return;
    if (event.data instanceof ArrayBuffer) return handleIncomingPcm(event.data);
    try { handleMessage(JSON.parse(event.data)); } catch (err) { console.error(err); }
  };
}

function connectRemote(force = false) {
  if (shouldShowAuthGate()) {
    showAuthGate();
    return;
  }
  if (!state.remote.url && state.remote.relay) {
    state.remote.url = buildRemoteWsUrl(state.remote.relay, state.remote.token, state.remoteBrowserId);
  }
  if (!state.remote.url) {
    showRemoteSetupPrompt();
    return;
  }
  if (!force && state.ws && state.ws.readyState <= WebSocket.OPEN) return;

  const generation = ++state.generation;
  if (state.ws && state.ws.readyState < 2) state.ws.close();

  state.ws = new WebSocket(state.remote.url);
  state.ws.binaryType = 'arraybuffer';
  state.connectStartedAt = Date.now();

  state.ws.onopen = () => {
    if (generation !== state.generation) return;
    state.connectStartedAt = 0;
    state.lastPongAt = Date.now();
    state.pongPendingSince = 0;
    state.remoteSelectedOnCurrentSocket = '';
    setRemoteRelayOnline();
    setRemoteCheck('Relay connected');
    sendRemoteMessage(REMOTE_MESSAGE_TYPES.DEVICE_LIST);
    if (state.remoteSelectedDeviceId) selectRemoteDevice(state.remoteSelectedDeviceId, { force: true });
    if (state.remote.pairingCode) confirmRemotePairing(state.remote.pairingCode);
    sendRemoteMessage(REMOTE_MESSAGE_TYPES.PING);
  };

  state.ws.onclose = event => {
    if (generation !== state.generation) return;
    state.connectStartedAt = 0;
    const reason = remoteCloseReason(event);
    setRemoteCheck(reason.status, reason.detail);
    setOffline('Remote relay disconnected', reason.overlayText);
    showRemoteSettingsAction();
    setTimeout(connect, 2500);
  };

  state.ws.onerror = () => {};

  state.ws.onmessage = event => {
    if (generation !== state.generation) return;
    if (event.data instanceof ArrayBuffer) return handleIncomingPcm(event.data);
    try { handleRemoteRelayMessage(JSON.parse(event.data)); } catch (err) { console.error(err); }
  };
}

function showRemoteSetupPrompt() {
  if (shouldShowAuthGate()) {
    showAuthGate();
    return;
  }
  if (state.account.authenticated) {
    setOffline('Remote relay URL required', 'Enter the relay URL in Settings > Remote, then apply Remote again.');
    setRemoteCheck('Missing relay URL');
  } else {
    const missing = [];
    if (!state.remote.relay) missing.push('relay URL');
    if (!state.remote.token) missing.push('relay token');
    if (!state.remote.pairingCode) missing.push('pairing code');
    setOffline('Manual remote setup required', `Enter ${missing.join(', ')} in Settings > Remote, then apply and pair this browser.`);
    setRemoteCheck(missing.length ? `Missing ${missing.join(', ')}` : 'Manual setup incomplete');
  }
  showRemoteSettingsAction();
  if (!state.remoteSetupPromptShown) {
    state.remoteSetupPromptShown = true;
    openSettings('remote');
  }
}

function showRemoteSettingsAction() {
  // Hosted/mobile users must always have a way back into Remote settings
  // from a blocking overlay; otherwise a bad saved token can trap the page.
  $('overlay-actions').classList.remove('hidden');
}

function shouldShowAuthGate() {
  // In hosted mode the normal path is account login. Manual token setup is
  // still available, but it is intentionally a secondary escape hatch.
  return state.remote.enabled
    && !state.account.authenticated
    && !state.remote.token
    && !state.authOverlayDismissed;
}

function shouldUseAccountPage() {
  // HTTPS deployments use clean account routes. The local proxy stays on its
  // direct workspace root and never introduces an account navigation step.
  return state.account.statusKnown
    && state.remote.enabled
    && location.protocol === 'https:';
}

function openAccountPage() {
  const next = `${location.pathname}${location.search}${location.hash}`;
  const loginPage = location.protocol === 'https:' ? '/login' : 'login.html';
  location.replace(`${loginPage}?next=${encodeURIComponent(next)}`);
}

function syncAuthInputs(force = false) {
  const fields = [
    ['auth-remote-url', state.remote.relay || defaultRemoteRelay()],
    ['auth-account-user', state.account.userId || ''],
    ['auth-account-name', state.account.userName || ''],
  ];
  for (const [id, value] of fields) {
    const input = $(id);
    if (!input) continue;
    if (force || !input.value) input.value = value;
  }
}

function setAuthStatus(text, tone = '') {
  const status = $('auth-status');
  if (!status) return;
  status.textContent = text;
  status.classList.remove('good', 'bad');
  if (tone) status.classList.add(tone);
}

function defaultAuthStatusText() {
  if (!state.remote.relay) return 'Enter the relay URL, then log in or register.';
  if (state.account.registrationEnabled === false) {
    return 'Log in with an existing account. Registration is disabled on this relay.';
  }
  return 'Log in on each browser. Register once, then copy the agent token to the Altitude PC.';
}

function updateAuthControls() {
  const register = $('auth-register');
  if (!register) return;
  const disabled = state.account.registrationEnabled === false;
  register.disabled = disabled;
  register.title = disabled ? 'Registration is disabled on this relay.' : '';
}

function showAuthGate(message = '') {
  if (shouldUseAccountPage()) {
    openAccountPage();
    return;
  }
  syncAuthInputs(false);
  if (message) setAuthStatus(message);
  else setAuthStatus(defaultAuthStatusText());
  updateAuthControls();
  $('overlay').classList.add('hidden');
  $('auth-overlay').classList.remove('hidden');
}

function hideAuthGate() {
  $('auth-overlay').classList.add('hidden');
}

function updateAuthGate() {
  if (shouldShowAuthGate()) showAuthGate();
  else hideAuthGate();
}

function openManualRemoteSetup() {
  state.authOverlayDismissed = true;
  saveAuthManualPreference(true);
  hideAuthGate();
  openSettings('remote');
}

function openAccountLogin() {
  if (state.remote.enabled && location.protocol === 'https:') {
    openAccountPage();
    return;
  }
  state.authOverlayDismissed = false;
  saveAuthManualPreference(false);
  closeSettings();
  showAuthGate('Sign in or register a hosted relay account.');
}

function continueAfterAuth() {
  state.authOverlayDismissed = true;
  saveAuthManualPreference(false);
  hideAuthGate();
  connect(true);
}

function remoteCloseReason(event) {
  // Browsers often hide the exact WebSocket failure for security reasons.
  // When the relay does provide a policy-close reason, surface it in the
  // settings status; otherwise guide the user to check saved remote setup.
  const code = event?.code || 0;
  const reason = String(event?.reason || '').trim();
  const setupHint = state.account.authenticated
    ? 'Check the relay URL, network connection, and your account session.'
    : 'Check the relay URL, token, and pairing code.';
  if (reason) {
    return {
      status: `Relay disconnected (${code})`,
      detail: reason,
      overlayText: `The relay closed the connection: ${reason}. ${setupHint}`,
    };
  }
  if (code === 1006) {
    return {
      status: 'Relay connection refused',
      detail: 'The browser could not complete the WebSocket connection.',
      overlayText: `The relay connection could not be opened. ${setupHint}`,
    };
  }
  return {
    status: 'Relay disconnected',
    detail: code ? `WebSocket closed with code ${code}.` : '',
    overlayText: `Waiting for the relay connection to recover. If this persists, ${setupHint.toLowerCase()}`,
  };
}

function send(action) {
  // Returning false lets callers decide whether to show local feedback.
  if (state.remote.enabled) return sendRemoteAction(action);
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(action));
  return true;
}

function sendRemoteAction(action) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;

  if (action.action === 'ping') return sendRemoteMessage(REMOTE_MESSAGE_TYPES.PING);
  if (!state.remoteSelectedDeviceId) {
    addErrorMessage('No remote agent paired.');
    return false;
  }

  if (action.action === 'sim_com1' || action.action === 'sim_com2') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.RADIO_SET, {
      com: action.action === 'sim_com2' ? 2 : 1,
      freq: normalizeFreq(action.freq),
      station: action.station || '',
    });
  }

  if (action.action === 'send_message') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.CHAT_SEND, {
      recipient: action.recipient,
      text: action.text,
    });
  }

  if (action.action === 'weather_request') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.WEATHER_REQUEST, {
      kind: action.kind,
      icao: action.icao,
      source: action.source,
      role: action.role,
    });
  }

  if (action.action === 'atis_request') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.ATIS_REQUEST, {
      callsign: action.callsign,
    });
  }

  if (action.action === 'sim_squawk') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.XPDR_SET_SQUAWK, { code: action.code });
  }

  if (action.action === 'sim_xpdr') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.XPDR_SET_MODE, { mode: action.mode });
  }

  if (action.action === 'sim_ident') return sendRemoteMessage(REMOTE_MESSAGE_TYPES.XPDR_IDENT);

  if (action.action === 'voice_tx_start') {
    return sendRemoteMessage(REMOTE_MESSAGE_TYPES.TX_START, { com: Number(action.com) === 2 ? 2 : 1 });
  }

  if (action.action === 'voice_tx_stop') return sendRemoteMessage(REMOTE_MESSAGE_TYPES.TX_STOP);

  if (action.action === 'voice_tx_monitor_start') {
    addErrorMessage('Remote TX monitor is local-only for now.');
    return false;
  }

  if (action.action === 'test_audio') {
    addLocal('Test RX is local-only in this remote preview.');
    return false;
  }

  addErrorMessage(`Remote action is not supported yet: ${action.action}`);
  return false;
}

function sendRemoteMessage(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify({
    v: REMOTE_PROTOCOL_VERSION,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload,
  }));
  return true;
}

function confirmRemotePairing(code = '') {
  // Pairing binds this browser id to the local agent inside the relay. The
  // relay, not the browser, decides which agent the code belongs to.
  const pairingCode = normalizePairingCode(code || $('settings-remote-pairing')?.value || '');
  if (!pairingCode) {
    addErrorMessage('Pairing code is required.');
    return false;
  }
  if (!state.remote.enabled) {
    addErrorMessage('Enable Remote mode before pairing this browser.');
    return false;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addErrorMessage('Remote relay is not connected yet.');
    return false;
  }
  state.remote.pairingCode = pairingCode;
  setRemoteCheck('Pairing sent');
  saveRemoteSettings({
    enabled: true,
    relay: state.remote.relay,
    token: state.remote.token,
    deviceId: state.remoteSelectedDeviceId,
    pairingCode,
  });
  return sendRemoteMessage(REMOTE_MESSAGE_TYPES.PAIRING_CONFIRM, { code: pairingCode });
}

function renewRemotePairingCode() {
  // A fresh code must be requested by the local agent because the relay
  // binds codes to the online agent device, not to arbitrary browsers.
  if (state.remote.enabled) {
    addErrorMessage('Open the local VoxHF webapp on the Altitude PC to renew the pairing code.');
    return false;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addErrorMessage('Local proxy is not connected yet.');
    return false;
  }
  setRemoteCheck('Requesting pairing code');
  return send({ action: 'remote_pairing_renew' });
}

async function copyRemotePairingCode() {
  const code = normalizePairingCode(state.localRemotePairing?.code || $('settings-remote-pairing')?.value || state.remote.pairingCode || '');
  if (!code) {
    addErrorMessage('No pairing code to copy. Generate or enter one first.');
    return false;
  }
  try {
    await copyTextToClipboard(code);
    setRemoteCheck('Pairing code copied');
    addLocal('Remote pairing code copied.');
    return true;
  } catch (err) {
    addErrorMessage(`Could not copy pairing code: ${err.message || err}`);
    return false;
  }
}

function forgetRemotePairing() {
  // This revokes only the current browser's access to the paired agent. The
  // relay persists the revocation; other paired browsers are unaffected.
  if (!state.remote.enabled) {
    addErrorMessage('Remote mode is not enabled.');
    return false;
  }
  if (!state.remoteSelectedDeviceId) {
    clearRemotePairingCode();
    addErrorMessage('No paired remote agent to forget.');
    return false;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addErrorMessage('Remote relay is not connected yet.');
    return false;
  }
  return sendRemoteMessage(REMOTE_MESSAGE_TYPES.PAIRING_REVOKE, { deviceId: state.remoteSelectedDeviceId });
}

// JSON messages update application state. Binary messages are PCM audio
// and are handled directly by connect().
function handleMessage(data) {
  switch (data.kind) {
    case 'init':
      state.lanIp = data.lanIp || '';
      state.version = data.version || state.version;
      state.updateCheckUrl = data.updateCheckUrl || state.updateCheckUrl;
      checkForUpdates(state.updateCheckUrl || 'release.json');
      state.voiceServer = data.voiceServer || state.voiceServer;
      state.txSampleRate = Number(data.txSampleRate) || state.txSampleRate;
      setWebTxStatus(data.webTxEnabled !== false, Boolean(data.txReady));
      restoreOwnPosition(data.ownPosition);
      restoreStations(data.stations);
      restoreComFrequencies(data.comFrequencies, data.comStations);
      restoreXpdrState(data.xpdrState);
      setFlightPlanStatus(data.flightPlanStatus || 'missing', data.flightPlan, data.weatherState);
      if (data.remotePairing) applyLocalRemotePairing(data.remotePairing, false);
      if (data.callsign) state.callsign = data.callsign;
      if (Array.isArray(data.log)) data.log.forEach(addMessage);
      if (data.connected) setOnline(data.callsign);
      else setOverlay('altitude');
      maybeShowUpdateNotice();
      break;
    case 'status':
      if (data.connected) setOnline(data.callsign);
      else setOverlay('altitude');
      break;
    case 'update_policy':
      applyUpdatePolicy(data);
      break;
    case 'login':
      if (data.own) setOnline(data.callsign);
      break;
    case 'logout':
      setOverlay('altitude');
      break;
    case 'message':
      addMessage(data);
      maybeLearnStation(data.sender);
      break;
    case 'freq_update':
      setComLabel(data.com, data.freq, data.station);
      break;
    case 'atc_detected':
    case 'atc_voice_info':
      addStation(data);
      break;
    case 'own_position':
      updateOwnPosition(data);
      updateXpdrFromNetwork(data);
      break;
    case 'xpdr_update':
      updateXpdrFromNetwork(data);
      break;
    case 'flight_plan_status':
      setFlightPlanStatus(data.status, data.flightPlan, data.weatherState);
      break;
    case 'weather_update':
      if (data.weatherState) {
        state.weatherState = normalizeWeatherState(data.weatherState);
        clearResolvedWeatherRequests(state.weatherState);
        renderWeatherPanel();
      }
      break;
    case 'remote_pairing':
      applyLocalRemotePairing(data, true);
      addLocal(`Remote pairing code: ${data.code}`);
      break;
    case 'voice':
      pulseRx();
      break;
    case 'voice_tx':
      setTxUi(Boolean(data.active), data.com, data.monitorOnly);
      if (data.text) addVoiceTxFeedback(data.text);
      break;
    case 'voice_tx_ready':
      setWebTxStatus(data.enabled !== false, Boolean(data.ready));
      break;
    case 'pong':
      state.lastPongAt = Date.now();
      state.pongPendingSince = 0;
      state.voiceServer = data.voiceServer || state.voiceServer;
      if ('txReady' in data) setWebTxStatus(state.webTxEnabled, Boolean(data.txReady));
      if (data.flightPlanStatus) setFlightPlanStatus(data.flightPlanStatus);
      if (data.connected) setOnline(data.callsign);
      else if (state.connected) setOverlay('altitude');
      updateSettingsView();
      break;
    case 'error':
      addErrorMessage(data.text || 'Proxy error.');
      setTxUi(false);
      break;
  }
}

function handleRemoteRelayMessage(data) {
  // Remote relay messages use the shared protocol envelope instead of the
  // local proxy's kind-based JSON. Convert them into the same UI state.
  if (!data || data.v !== REMOTE_PROTOCOL_VERSION || !data.type) return;

  switch (data.type) {
    case REMOTE_MESSAGE_TYPES.PONG:
      state.lastPongAt = Date.now();
      state.pongPendingSince = 0;
      updateSettingsView();
      return;
    case REMOTE_MESSAGE_TYPES.RELAY_IDENTITY:
      applyRemoteIdentity(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.DEVICE_STATE:
      markRemoteUpdate();
      updateRemoteDevice(data.payload || {});
      clearRemotePairingCode();
      return;
    case REMOTE_MESSAGE_TYPES.PAIRING_REVOKED:
      applyRemotePairingRevoked(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.AGENT_STATUS:
      markRemoteUpdate();
      applyRemoteAgentStatus(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.RADIO_STATE:
      markRemoteUpdate();
      applyRemoteRadioState(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.STATIONS_STATE:
      markRemoteUpdate();
      applyRemoteStationsState(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.WEATHER_STATE:
      markRemoteUpdate();
      applyRemoteWeatherState(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.CHAT_MESSAGE:
      markRemoteUpdate();
      addRemoteChatMessage(data.payload || {});
      return;
    case REMOTE_MESSAGE_TYPES.RELAY_ERROR:
      setRemoteCheck(data.payload?.message || 'Remote relay error.');
      addErrorMessage(data.payload?.message || 'Remote relay error.');
      return;
  }
}

function applyRemoteIdentity(payload) {
  // The relay owns the authenticated user scope. The browser only displays
  // it so hosted sessions make token mistakes obvious to the pilot.
  state.remoteIdentity = {
    userId: String(payload.userId || ''),
    userName: String(payload.userName || payload.userId || ''),
  };
  applyUpdatePolicy({
    latestVersion: payload.recommendedAgentVersion || payload.relayVersion || '',
    recommendedLocalVersion: payload.recommendedAgentVersion || payload.relayVersion || '',
    minimumLocalVersion: payload.minimumAgentVersion || '',
    downloadUrl: payload.downloadUrl || '',
    source: 'relay',
  });
  updateSettingsView();
}

function clearRemotePairingCode() {
  if (!state.remote.pairingCode) return;
  state.remote.pairingCode = '';
  saveRemoteSettings({
    enabled: state.remote.enabled,
    relay: state.remote.relay,
    token: state.remote.token,
    deviceId: state.remoteSelectedDeviceId,
    pairingCode: '',
  });
  const input = $('settings-remote-pairing');
  if (input && document.activeElement !== input) input.value = '';
}

function applyRemotePairingRevoked(payload) {
  const deviceId = String(payload.deviceId || '');
  if (deviceId && state.remoteSelectedDeviceId === deviceId) {
    state.remoteDevices.delete(deviceId);
    state.remoteSelectedDeviceId = '';
  }
  clearRemotePairingCode();
  saveRemoteSettings({
    enabled: state.remote.enabled,
    relay: state.remote.relay,
    token: state.remote.token,
    deviceId: '',
    pairingCode: '',
  });
  setOffline(
    state.account.authenticated ? 'Remote access refreshed' : 'Remote agent unpaired',
    state.account.authenticated
      ? 'This browser access was refreshed or revoked. If your local agent is online, it will be selected again automatically.'
      : 'Enter a new pairing code to control this agent again.'
  );
  showRemoteSettingsAction();
  setRemoteCheck('Pairing revoked');
  addLocal('Remote pairing forgotten for this browser.');
  updateSettingsView();
}

function setRemoteRelayOnline() {
  clearAltitudeOfflineTimer();
  $('overlay').classList.add('hidden');
  $('dot').classList.add('online');
  $('status-text').textContent = 'Relay online';
  setControlsDisabled(false);
  setWebTxStatus(false, false);
  updateSettingsView();
}

function updateRemoteDevice(device) {
  const id = String(device.deviceId || '');
  if (!id) return;
  if (device.agentVersion) {
    state.version = device.agentVersion;
    maybeShowUpdateNotice();
  }

  if (device.online) state.remoteDevices.set(id, device);
  else state.remoteDevices.delete(id);

  const selectedOnline = Boolean(state.remoteSelectedDeviceId && state.remoteDevices.has(state.remoteSelectedDeviceId));

  if (device.online && (!state.remoteSelectedDeviceId || !selectedOnline)) {
    setRemoteCheck('Agent online');
    selectRemoteDevice(id, { force: true });
  } else if (state.remoteSelectedDeviceId === id && device.online) {
    setRemoteCheck('Agent online');
    if (state.remoteSelectedOnCurrentSocket !== id) selectRemoteDevice(id, { force: true });
  } else if (state.remoteSelectedDeviceId === id) {
    state.remoteSelectedDeviceId = '';
    state.remoteSelectedOnCurrentSocket = '';
    setRemoteCheck('Agent offline');
    setOffline('Remote agent offline', 'Start VoxHF on the PC with Altitude and keep remote agent mode enabled.');
    showRemoteSettingsAction();
  }
  updateSettingsView();
}

function selectRemoteDevice(deviceId, options = {}) {
  if (!deviceId) return;
  const changed = state.remoteSelectedDeviceId !== deviceId;
  state.remoteSelectedDeviceId = deviceId;
  if (state.remote.enabled) {
    saveRemoteSettings({
      enabled: true,
      relay: state.remote.relay,
      token: state.remote.token,
      deviceId,
    });
  }
  if (options.force || changed || state.remoteSelectedOnCurrentSocket !== deviceId) {
    if (sendRemoteMessage(REMOTE_MESSAGE_TYPES.DEVICE_SELECT, { deviceId })) {
      state.remoteSelectedOnCurrentSocket = deviceId;
    }
  }
  const device = state.remoteDevices.get(deviceId);
  if (changed && device?.deviceName) addLocal(`Remote agent paired: ${device.deviceName}`);
  updateSettingsView();
}

function applyRemoteAgentStatus(payload) {
  if (payload.agentVersion) {
    state.version = payload.agentVersion;
    maybeShowUpdateNotice();
  }
  if (payload.flightPlanStatus) setFlightPlanStatus(payload.flightPlanStatus);
  if (payload.callsign) state.callsign = payload.callsign;
  if (Number(payload.txSampleRate) > 0) state.txSampleRate = Number(payload.txSampleRate);
  if ('webTxEnabled' in payload || 'txReady' in payload) {
    const enabled = 'webTxEnabled' in payload ? payload.webTxEnabled !== false : state.webTxEnabled;
    const ready = 'txReady' in payload ? Boolean(payload.txReady) : state.txReady;
    setWebTxStatus(enabled, ready);
  }
  if (payload.squawk || payload.xpdrMode) {
    updateXpdrFromNetwork({
      squawk: payload.squawk,
      mode: payload.xpdrMode,
    });
  }
  if (payload.connected) setOnline(payload.callsign);
  else setOverlay('altitude');
}

function applyRemoteRadioState(payload) {
  if (payload.com1) setComLabel(1, payload.com1, payload.station1 || '');
  if (payload.com2) setComLabel(2, payload.com2, payload.station2 || '');
}

function applyRemoteStationsState(payload) {
  restoreOwnPosition(payload.ownPosition);
  restoreStations(payload.stations);
}

function applyRemoteWeatherState(payload) {
  setFlightPlanStatus(payload.flightPlanStatus || 'missing', payload.flightPlan, payload.weatherState);
}

function addRemoteChatMessage(payload) {
  const sender = payload.sender || 'REMOTE';
  const recipient = payload.recipient || '';
  const type = recipient === '*'
    ? 'broadcast'
    : recipient.startsWith('@')
      ? 'frequency'
      : 'private';
  addMessage({
    kind: 'message',
    type,
    sender,
    recipient,
    text: payload.text || '',
    direction: payload.direction === 'outgoing' ? 'outgoing' : 'incoming',
    timestamp: payload.timestamp || new Date().toISOString(),
  });
}

function setOnline(callsign) {
  // "Connected" here means the proxy reports an active Altitude/FSD flow.
  clearAltitudeOfflineTimer();
  state.connected = true;
  if (callsign) state.callsign = callsign;
  $('overlay').classList.add('hidden');
  $('dot').classList.add('online');
  $('status-text').textContent = 'Connected';
  $('callsign').textContent = state.callsign || '---';
  setControlsDisabled(false);
  updateSettingsView();
}

function setOverlay(mode) {
  // The overlay distinguishes "proxy not reachable" from "proxy reachable,
  // Altitude not connected yet" so startup issues are easier to understand.
  if (mode === 'altitude') {
    const title = state.remote.enabled
      ? (state.remoteDevices.size ? 'Altitude/IVAO waiting' : 'Local agent waiting')
      : 'Altitude disconnected';
    const text = state.remote.enabled
      ? (state.remoteDevices.size
        ? 'The local VoxHF agent is online, but Altitude is not connected to IVAO yet.'
        : 'The relay is online, but the local VoxHF agent is not connected. Start VoxHF on the Altitude PC.')
      : `Proxy is active. In PilotUI, use Simulator Address: ${state.lanIp || '...'}`;
    // FSD status can briefly report disconnected during browser recovery or
    // PilotCore reconnects. If the UI was online, wait a moment before
    // showing the blocking overlay so short reconnects do not look fatal.
    if (state.connected) {
      clearAltitudeOfflineTimer();
      state.altitudeOfflineTimer = setTimeout(() => {
        state.altitudeOfflineTimer = null;
        setOffline(title, text);
      }, 2500);
      $('status-text').textContent = 'Rechecking';
      return;
    }
    setOffline(title, text);
  } else {
    clearAltitudeOfflineTimer();
    setOffline(
      state.remote.enabled ? 'Remote relay unavailable' : 'Proxy unavailable',
      state.remote.enabled
        ? (state.account.authenticated
          ? 'Check the relay URL, account session, and network connection.'
          : 'Check the relay URL, token, pairing code, and network connection.')
        : 'Start start.bat or node proxy.js.'
    );
    if (state.remote.enabled) showRemoteSettingsAction();
  }
}

function setOffline(title, text) {
  // Disconnecting the control channel should also release any browser-held
  // microphone/PTT state.
  state.connected = false;
  $('overlay-actions').classList.add('hidden');
  $('overlay-title').textContent = title;
  $('overlay-text').innerHTML = enc(text).replace(/Simulator Address: ([^ ]+)/, 'Simulator Address: <code>$1</code>');
  $('overlay').classList.remove('hidden');
  $('dot').classList.remove('online');
  $('status-text').textContent = 'Offline';
  setControlsDisabled(true);
  stopTx();
  updateSettingsView();
}

function setControlsDisabled(disabled) {
  // Disable only actions that require a live proxy/Altitude session. The
  // rest of the UI, including visible messages, remains inspectable.
  CONTROL_IDS.forEach(id => {
    if (id === 'settings-test-audio') {
      $(id).disabled = false;
      return;
    }
    const remoteUnsupportedControl = state.remote.enabled && id === 'settings-monitor-tx';
    $(id).disabled = disabled || remoteUnsupportedControl;
  });
}

function setFlightPlanStatus(status, flightPlan = null, weatherState = null) {
  // Flight plan status comes from FSD traffic. Repeated server errors are
  // reduced to this one transient notice so the chat stays readable.
  state.flightPlanStatus = status === 'filed' ? 'filed' : 'missing';
  if (flightPlan) state.flightPlan = normalizeFlightPlanState(flightPlan);
  else if (state.flightPlanStatus === 'missing') state.flightPlan = { departure: '', destination: '', alternate: '' };
  if (weatherState) state.weatherState = normalizeWeatherState(weatherState);
  else if (state.flightPlanStatus === 'missing') {
    state.weatherState = emptyWeatherState();
    clearAllWeatherRequests(false);
  }
  clearResolvedWeatherRequests(state.weatherState);
  const filed = state.flightPlanStatus === 'filed';
  $('flight-plan-dot').classList.toggle('online', filed);
  const route = state.flightPlan.departure && state.flightPlan.destination
    ? ` ${state.flightPlan.departure}-${state.flightPlan.destination}`
    : '';
  $('flight-plan-text').textContent = filed ? `Flight plan${route}` : 'No flight plan';
  renderWeatherPanel();
  updateSettingsView();
}

function emptyWeatherState() {
  return {
    departure: { icao: '', metar: null, taf: null },
    destination: { icao: '', metar: null, taf: null },
  };
}

function normalizeFlightPlanState(value = {}) {
  return {
    departure: normalizeIcao(value.departure),
    destination: normalizeIcao(value.destination),
    alternate: normalizeIcao(value.alternate),
  };
}

function normalizeWeatherState(value = {}) {
  return {
    departure: normalizeWeatherSlot(value.departure),
    destination: normalizeWeatherSlot(value.destination),
  };
}

function normalizeWeatherSlot(value = {}) {
  return {
    icao: normalizeIcao(value.icao),
    metar: normalizeWeatherEntry(value.metar),
    taf: normalizeWeatherEntry(value.taf),
  };
}

function normalizeWeatherEntry(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    text: String(value.text || ''),
    receivedAt: String(value.receivedAt || ''),
    source: String(value.source || 'IVAO'),
  };
}

function normalizeIcao(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(text) ? text : '';
}

function clearAltitudeOfflineTimer() {
  if (!state.altitudeOfflineTimer) return;
  clearTimeout(state.altitudeOfflineTimer);
  state.altitudeOfflineTimer = null;
}

function setWebTxStatus(enabled, ready) {
  // Web TX normally learns its TS2 transmit seed from voice-channel join
  // traffic. A real Altitude PTT packet is only the fallback path.
  state.webTxEnabled = enabled;
  state.txReady = ready;
  const box = $('webtx-status');
  box.classList.remove('ready', 'warning', 'waiting');

  if (!enabled) {
    box.classList.add('warning');
    box.textContent = state.remote.enabled ? 'Remote Web TX unavailable.' : 'Web TX disabled in config.json.';
    updateSettingsView();
    return;
  }

  if (ready) {
    box.classList.add('ready');
    box.textContent = 'Web TX ready.';
    updateSettingsView();
    return;
  }

  box.classList.add('warning', 'waiting');
  box.textContent = 'Web TX waiting: join a voice channel.';
  updateSettingsView();
}

function openSettings(tab = state.activeSettingsTab) {
  state.activeSettingsTab = tab || 'audio';
  renderSettingsTab();
  syncRemoteSettingsInputs(true);
  updateSettingsView();
  $('settings-modal').classList.remove('hidden');
  if (state.activeSettingsTab === 'remote') refreshAccountStatus();
}

function closeSettings() {
  $('settings-modal').classList.add('hidden');
}

function renderSettingsTab() {
  document.querySelectorAll('.settings-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll('.settings-page').forEach(page => {
    page.classList.toggle('hidden', page.dataset.settingsPage !== state.activeSettingsTab);
  });
  if (state.activeSettingsTab === 'remote') syncRemoteSettingsInputs(false);
}

function syncRemoteSettingsInputs(force = false) {
  // Live status updates happen every few seconds. Remote form inputs are
  // editable drafts, so they are populated only on open/tab entry instead
  // of being overwritten by every settings refresh.
  const fields = [
    ['settings-remote-url', state.remote.relay || ''],
    ['settings-remote-token', state.remote.token || ''],
    ['settings-remote-pairing', state.remote.pairingCode || ''],
  ];

  for (const [id, value] of fields) {
    const input = $(id);
    if (!input) continue;
    if (force || !input.value) input.value = value;
  }
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value || '---';
}

function setSettingTone(id, tone) {
  const element = $(id);
  if (!element) return;
  element.classList.remove('good', 'warning', 'bad');
  if (tone) element.classList.add(tone);
}

async function checkForUpdates(url = 'release.json') {
  // Update checks are passive: the browser downloads a tiny JSON manifest and
  // shows a link. VoxHF never downloads or runs an update automatically.
  const target = String(url || '').trim();
  if (!target) return;
  try {
    const response = await fetch(target, { cache: 'no-store' });
    if (!response.ok) return;
    const manifest = await response.json();
    applyUpdatePolicy({
      latestVersion: manifest.latestVersion || manifest.version || '',
      recommendedLocalVersion: manifest.recommendedLocalVersion || manifest.latestVersion || manifest.version || '',
      minimumLocalVersion: manifest.minimumLocalVersion || '',
      downloadUrl: manifest.downloadUrl || '',
      notesUrl: manifest.notesUrl || '',
      source: 'manifest',
    });
  } catch (_) {
    // Update checks must never interrupt flying. A failed check simply means no
    // update banner for this session.
  }
}

function applyUpdatePolicy(policy) {
  const next = {
    latestVersion: normalizeVersionText(policy.latestVersion || state.updatePolicy.latestVersion),
    recommendedLocalVersion: normalizeVersionText(policy.recommendedLocalVersion || state.updatePolicy.recommendedLocalVersion),
    minimumLocalVersion: normalizeVersionText(policy.minimumLocalVersion || state.updatePolicy.minimumLocalVersion),
    downloadUrl: policy.downloadUrl || state.updatePolicy.downloadUrl || 'https://github.com/leledeste/voxhf/releases/latest',
    notesUrl: policy.notesUrl || state.updatePolicy.notesUrl || '',
    source: policy.source || state.updatePolicy.source || '',
  };
  state.updatePolicy = next;
  maybeShowUpdateNotice();
}

function maybeShowUpdateNotice() {
  const notice = $('update-notice');
  if (!notice) return;

  const current = normalizeVersionText(state.version);
  const policy = state.updatePolicy;
  const minimum = normalizeVersionText(policy.minimumLocalVersion);
  const recommended = normalizeVersionText(policy.recommendedLocalVersion || policy.latestVersion);
  const latest = normalizeVersionText(policy.latestVersion || recommended);
  const required = current && minimum && compareVersions(current, minimum) < 0;
  const outdated = current && recommended && compareVersions(current, recommended) < 0;

  if (!required && !outdated) {
    notice.classList.add('hidden');
    return;
  }

  const key = `${current}|${minimum}|${recommended}|${latest}`;
  if (!required && localStorage.getItem(UPDATE_NOTICE_STORAGE_KEY) === key) {
    notice.classList.add('hidden');
    return;
  }

  notice.dataset.dismissKey = key;
  notice.classList.toggle('required', required);
  $('update-title').textContent = required ? 'VoxHF update required' : 'VoxHF update available';
  $('update-text').textContent = required
    ? `This relay expects VoxHF ${minimum} or newer. You are running ${current}.`
    : `VoxHF ${latest || recommended} is available. You are running ${current}.`;
  const link = $('update-link');
  link.href = policy.downloadUrl || 'https://github.com/leledeste/voxhf/releases/latest';
  link.textContent = required ? 'Download update' : 'View release';
  $('update-dismiss').classList.toggle('hidden', required);
  notice.classList.remove('hidden');
}

function dismissUpdateNotice() {
  const notice = $('update-notice');
  if (!notice || notice.classList.contains('required')) return;
  if (notice.dataset.dismissKey) localStorage.setItem(UPDATE_NOTICE_STORAGE_KEY, notice.dataset.dismissKey);
  notice.classList.add('hidden');
}

function normalizeVersionText(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 4; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true });
}

function parseVersion(value) {
  const match = normalizeVersionText(value).match(/^([0-9]+(?:\.[0-9]+){1,3})(?:-([A-Za-z0-9.:-]+))?/);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return { parts, prerelease: match[2] || '' };
}

function updateSettingsView() {
  // Settings is a read-only mirror of live app/proxy state. It should never
  // be the only place where an operational warning is shown.
  const wsState = state.ws?.readyState;
  const proxy = wsState === WebSocket.OPEN ? (state.remote.enabled ? 'Relay connected' : 'Connected')
    : wsState === WebSocket.CONNECTING ? 'Connecting'
    : 'Offline';
  const heartbeat = state.lastPongAt
    ? `${Math.round((Date.now() - state.lastPongAt) / 1000)}s ago`
    : 'Waiting';
  const webTx = !state.webTxEnabled ? 'Disabled'
    : state.txReady ? 'Ready'
    : 'Waiting for voice channel';
  const output = state.audioCtx ? state.audioCtx.state : state.tx?.ctx?.state || 'Idle';
  const summary = remoteSummary();

  setText('settings-version', state.version);
  setText('settings-proxy', proxy);
  setText('settings-altitude', state.connected ? 'Connected' : 'Waiting');
  setText('settings-address', state.remote.enabled ? (state.remoteSelectedDeviceId || 'Waiting for agent') : state.lanIp);
  setText('settings-callsign', state.callsign);
  setText('settings-flight-plan', flightPlanLabel());
  setText('settings-voice-server', state.voiceServer);
  setText('settings-heartbeat', heartbeat);
  setText('settings-mic', state.micStatus);
  setText('settings-output', output);
  setText('settings-webtx', webTx);
  setText('settings-sample-rate', `${state.txSampleRate} Hz`);

  $('remote-pill').classList.toggle('hidden', !state.remote.enabled);
  $('remote-mode').textContent = state.remote.enabled ? 'Remote' : 'Local';
  setText('settings-remote-mode', state.remote.enabled ? 'Remote' : 'Local');
  setText('settings-remote-relay', displayRemoteRelay());
  setText('settings-remote-user', state.remote.enabled ? remoteUserLabel() : '---');
  setText('settings-account-state', state.account.authenticated ? `Logged in as ${remoteUserLabel()}` : 'Not logged in');
  setText('settings-remote-summary', summary.text);
  setSettingTone('settings-remote-summary', summary.tone);
  setText('settings-remote-check', state.remoteCheck.detail ? `${state.remoteCheck.status}: ${state.remoteCheck.detail}` : state.remoteCheck.status);
  setText('settings-remote-pairing-state', remotePairingStatusText());
  setText('settings-remote-agent-code', localRemotePairingText());
  setText('settings-remote-device', selectedRemoteDeviceLabel());
  setText('settings-remote-devices', String(state.remoteDevices.size));
  setText('settings-remote-agent', remoteAgentStatusText());
  setText('settings-remote-last-update', remoteLastUpdateText());

  $('settings-account-open').disabled = state.account.authenticated;
  $('settings-account-logout').disabled = !state.account.authenticated;
  $('settings-account-rotate-token').disabled = !state.account.authenticated;
  $('settings-account-security').classList.toggle('hidden', !state.account.authenticated);
  renderAccountSessions();
  $('settings-remote-pair').disabled = state.account.authenticated;
  updateAuthControls();
  syncAuthInputs(false);

  const renewButton = $('settings-remote-renew-code');
  renewButton.disabled = state.remote.enabled;
  renewButton.textContent = state.remote.enabled ? 'Renew From Local Webapp' : 'Renew Pairing Code';
  renewButton.title = state.remote.enabled
    ? 'Pairing codes are generated by the local VoxHF webapp on the Altitude PC.'
    : 'Ask the connected local agent for a fresh short-lived browser pairing code.';
}

// RX audio: the proxy decodes Speex into mono 16-bit PCM and this queues it.
async function ensureAudio() {
  // AudioContext creation is delayed until user interaction or first PCM
  // because browsers restrict autoplay-like audio startup.
  if (!state.audioCtx) state.audioCtx = new AudioContext({ sampleRate: RX_PCM_SAMPLE_RATE });
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
  updateSettingsView();
  return state.audioCtx;
}

function resetAudioSchedule() {
  // After standby/reconnect, stale scheduling times can place new audio too
  // far in the future. Reset close to currentTime for immediate RX.
  if (state.audioCtx) state.nextAudioTime = state.audioCtx.currentTime + 0.02;
  else state.nextAudioTime = 0;
}

async function resumeAudioIfNeeded() {
  // Browser tabs may suspend audio independently from WebSocket state.
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    try { await state.audioCtx.resume(); } catch (_) {}
  }
}

async function handleIncomingPcm(buffer) {
  // RX delivery is per-browser. A phone and a desktop can be connected to the
  // same relay, but each page has its own AudioContext and scheduling state.
  const now = Date.now();
  if (!state.lastPcmAt || now - state.lastPcmAt > 1500) resetAudioSchedule();
  state.lastPcmAt = now;

  try {
    await playPcm(buffer);
  } catch (err) {
    console.warn('RX playback failed:', err);
    resetAudioSchedule();
    updateSettingsView();
  }
}

async function playPcm(buffer) {
  // The proxy sends raw signed 16-bit mono PCM. Web Audio needs normalized
  // floats, then each chunk is scheduled back-to-back to avoid gaps.
  const ctx = await ensureAudio();
  if (ctx.state !== 'running') {
    updateSettingsView();
    return;
  }
  if (
    !Number.isFinite(state.nextAudioTime)
    || state.nextAudioTime > ctx.currentTime + 1.5
    || state.nextAudioTime < ctx.currentTime - 0.2
  ) {
    state.nextAudioTime = ctx.currentTime + 0.02;
  }
  const aligned = buffer.byteLength % 2 === 0 ? buffer : buffer.slice(0, buffer.byteLength - 1);
  const samples = new Int16Array(aligned);
  const audio = ctx.createBuffer(1, samples.length, RX_PCM_SAMPLE_RATE);
  const out = audio.getChannelData(0);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;

  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  const when = Math.max(ctx.currentTime + 0.02, state.nextAudioTime);
  source.start(when);
  state.nextAudioTime = when + audio.duration;
  pulseRx();
}

async function playBrowserTestTone() {
  // This is local to the browser. In Remote Preview it doubles as the user
  // gesture that unlocks mobile audio before live RX PCM arrives.
  const ctx = await ensureAudio();
  const samples = Math.floor(RX_PCM_SAMPLE_RATE * 0.45);
  const audio = ctx.createBuffer(1, samples, RX_PCM_SAMPLE_RATE);
  const out = audio.getChannelData(0);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 600, (samples - i) / 600);
    out[i] = Math.sin(2 * Math.PI * 440 * i / RX_PCM_SAMPLE_RATE) * 0.35 * fade;
  }
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  const when = ctx.currentTime + 0.02;
  source.start(when);
  state.nextAudioTime = when + audio.duration;
  pulseRx();
}

function pulseRx() {
  // RX is visual feedback for decoded PCM arrival, not necessarily a new
  // network packet every time.
  $('rx-light').classList.add('active');
  clearTimeout(state.rxTimer);
  state.rxTimer = setTimeout(() => $('rx-light').classList.remove('active'), 450);
}

// Stations come from FSD position lines and VOICE replies. _OBS entries stay hidden.
function addStation(data, render = true) {
  const callsign = String(data.callsign || data.atc || data.sender || '').toUpperCase();
  if (!callsign || !callsign.includes('_') || callsign.endsWith('_OBS')) return;
  const current = state.stations.get(callsign) || {};
  const lat = Number.isFinite(Number(data.lat)) ? Number(data.lat) : current.lat;
  const lon = Number.isFinite(Number(data.lon)) ? Number(data.lon) : current.lon;
  const next = {
    callsign,
    freq: data.freq || current.freq || '',
    lat,
    lon,
    voice: data.server || data.ts2Server
      ? `${data.server || data.ts2Server}/${data.channel || data.channelName || callsign}`
      : current.voice || '',
  };
  state.stations.set(callsign, next);
  if (render) renderStationMenus();
}

function maybeLearnStation(value) {
  // Private/system senders can mention controller callsigns before we have
  // a full position line. Add them so later frequency/voice data can merge.
  const callsign = String(value || '').toUpperCase();
  if (callsign.includes('_') && !callsign.endsWith('_OBS')) addStation({ callsign });
}

function updateOwnPosition(data, render = true) {
  // Own aircraft position arrives from outgoing FSD position packets and is
  // used only for station-distance sorting.
  const lat = Number(data.lat);
  const lon = Number(data.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  state.ownPosition = { lat, lon };
  if (render) renderStationMenus();
}

function restoreOwnPosition(data) {
  if (!data) return;
  updateOwnPosition(data, false);
}

function restoreStations(stations) {
  if (!Array.isArray(stations)) return;
  stations.forEach(station => addStation(station, false));
  renderStationMenus();
}

function renderStationMenus() {
  // Both COM menus share the same station list. Selecting a station tunes
  // only the chosen COM, which avoids accidental COM1/COM2 duplication.
  const list = [
    UNICOM_STATION,
    ...getMenuStations(),
  ];
  for (const com of [1, 2]) {
    const select = $(`com${com}-select`);
    const previous = select.value;
    select.innerHTML = '<option value="" disabled hidden>Stations by frequency</option>';
    for (const station of list) {
      const option = document.createElement('option');
      option.value = station.callsign;
      const distance = station.distanceNm !== undefined ? ` - ${Math.round(station.distanceNm)} NM` : '';
      option.textContent = `${station.callsign} - ${station.freq}${distance}`;
      select.appendChild(option);
    }
    select.value = stationSelectionForCom(com, list, previous);
  }
}

function stationSelectionForCom(com, list, previous) {
  const freq = state.comFrequencies[com] || normalizeFreq($(`com${com}-input`).value);
  const preferred = state.comStations[com];
  if (preferred) {
    const preferredStation = list.find(station => station.callsign === preferred);
    if (preferredStation && (!freq || normalizeFreq(preferredStation.freq) === freq)) return preferred;
  }

  if (!freq) return '';
  const match = list.find(station => normalizeFreq(station.freq) === freq);
  if (!match) {
    state.comStations[com] = '';
    return '';
  }
  state.comStations[com] = match.callsign;
  return match.callsign;
}

function getSortedStations() {
  // If coordinates are known, nearby stations rise to the top. Otherwise
  // callsign sorting keeps the list deterministic.
  return [...state.stations.values()]
    .map(station => ({
      ...station,
      distanceNm: stationDistanceNm(station),
    }))
    .sort((a, b) => {
      const ad = a.distanceNm;
      const bd = b.distanceNm;
      if (ad !== undefined && bd !== undefined) return ad - bd;
      if (ad !== undefined) return -1;
      if (bd !== undefined) return 1;
      return a.callsign.localeCompare(b.callsign);
    });
}

function getMenuStations() {
  // FSD can report controllers from the wider network. Once ownship position is
  // known, hide distance-aware stations that are clearly irrelevant to the
  // current flight area while still keeping stations without coordinates.
  return getSortedStations()
    .filter(station => station.freq && station.callsign !== UNICOM_STATION.callsign)
    .filter(station => station.distanceNm === undefined || station.distanceNm <= MAX_VISIBLE_STATION_DISTANCE_NM);
}

function stationDistanceNm(station) {
  // Missing coordinates are normal for some FSD events; undefined distance
  // means "show after distance-aware entries".
  if (!state.ownPosition) return undefined;
  if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) return undefined;
  return distanceNm(state.ownPosition.lat, state.ownPosition.lon, station.lat, station.lon);
}

function distanceNm(lat1, lon1, lat2, lon2) {
  // Haversine distance on an Earth radius expressed in nautical miles.
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tuneStation(com, station) {
  // Station selection is just a convenience wrapper around the manual COM
  // setter, so all validation and UI sync stay in one path.
  if (!station) return;
  if (!station.freq) return addLocal(`${station.callsign}: frequency is not known yet.`);
  $(`com${com}-input`).value = station.freq;
  tuneCom(com, station.freq, station.callsign);
}

function tuneCom(com, freq, station = '') {
  // The UI updates immediately after sending. If Altitude later reports a
  // different value, freq_update will correct the label.
  const clean = normalizeFreq(freq);
  if (!clean) return;
  const sent = send({ action: com === 2 ? 'sim_com2' : 'sim_com1', freq: clean, station });
  if (sent) setComLabel(com, clean, station);
}

function setComLabel(com, freq, station = '') {
  // Labels and inputs mirror each other so manually typed, selected, and
  // external PilotUI changes all leave the same visible state.
  const value = normalizeFreq(freq);
  if (!value) return;
  state.comFrequencies[com] = value;
  state.comStations[com] = station || stationForFrequency(value) || '';
  $(`com${com}-label`).textContent = `${value} MHz`;
  const input = $(`com${com}-input`);
  if (document.activeElement !== input) input.value = value;
  renderStationMenus();
}

function restoreComFrequencies(values, stations) {
  // The proxy keeps the latest known COM state. Loading it during init lets
  // a refreshed webapp show the current radio setup immediately.
  if (!values || typeof values !== 'object') return;
  for (const com of [1, 2]) {
    if (stations && stations[com]) state.comStations[com] = String(stations[com]).toUpperCase();
    if (values[com]) setComLabel(com, values[com], state.comStations[com]);
  }
}

function stationForFrequency(freq) {
  const value = normalizeFreq(freq);
  if (value === UNICOM_STATION.freq) return UNICOM_STATION.callsign;
  const match = getMenuStations().find(station => normalizeFreq(station.freq) === value);
  return match ? match.callsign : '';
}

function stationByCallsign(callsign) {
  // UNICOM is synthetic, so it is not stored inside the live station map.
  const key = String(callsign || '').toUpperCase();
  if (key === UNICOM_STATION.callsign) return UNICOM_STATION;
  return state.stations.get(key);
}

function normalizeFreq(value) {
  // Accept normal VHF COM frequencies only. The proxy repeats this check,
  // but doing it here keeps bad values out of both local and remote flows.
  const text = String(value || '').trim().replace(',', '.');
  const match = text.match(/^1\d{2}(?:\.\d{1,3})?$/);
  if (!match) return '';
  const number = Number(text);
  if (!Number.isFinite(number)) return '';
  if (number < 118 || number > 136.975) return '';
  return number.toFixed(3);
}

function formatComInput(value) {
  // COM inputs behave like the squawk field: type digits only and the dot is
  // inserted after the third digit, for example 124850 -> 124.850.
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)}.${digits.slice(3)}`;
}

function handleComInput(com, event) {
  // Tune only when the user has entered a complete six-digit VHF frequency.
  const formatted = formatComInput(event.target.value);
  if (event.target.value !== formatted) event.target.value = formatted;
  if (formatted.length === 7) tuneCom(com, formatted);
}

function restoreComInput(com) {
  // Partial COM edits are discarded on blur so the visible input never looks
  // like a real tuned frequency when it has not been sent to PilotCore.
  const input = $(`com${com}-input`);
  const formatted = formatComInput(input.value);
  if (formatted.length === 7) {
    input.value = formatted;
    return;
  }
  input.value = state.comFrequencies[com] || '';
}

function normalizeSquawk(value) {
  // Transponder codes are four octal digits, so 8/9 and other characters
  // are ignored before a command reaches PilotCore.
  return String(value || '').replace(/[^0-7]/g, '').slice(0, 4);
}

function saveXpdrState() {
  // Persist only the state requested from this webapp. This survives page
  // refresh without sending any transponder command again.
  try {
    localStorage.setItem(XPDR_STORAGE_KEY, JSON.stringify({
      squawk: state.squawk,
      mode: state.xpdrMode,
    }));
  } catch (_) {}
}

function applyXpdrState(data, persist = true) {
  // Network XPDR updates reflect what PilotCore is sending to IVAO. Applying
  // them here changes only the visible panel and browser cache, never the
  // real transponder state.
  if (!data || typeof data !== 'object') return;
  let changed = false;

  const squawk = normalizeSquawk(data.squawk);
  if (squawk.length === 4 && squawk !== state.squawk) {
    state.squawk = squawk;
    changed = true;
  }

  const mode = data.mode || data.xpdrMode;
  if ((mode === 'stby' || mode === 'alt') && mode !== state.xpdrMode) {
    state.xpdrMode = mode;
    changed = true;
  }

  if (!changed) return;
  renderXpdrMode();
  if (persist) saveXpdrState();
}

function restoreXpdrState(data) {
  applyXpdrState(data);
}

function updateXpdrFromNetwork(data) {
  applyXpdrState(data);
}

function sendSquawk(code) {
  // One helper is used by both the input field and .x/.sq commands so
  // validation and visible state stay identical.
  const clean = normalizeSquawk(code);
  if (clean.length !== 4) return false;
  if (!send({ action: 'sim_squawk', code: clean })) return false;
  state.squawk = clean;
  $('xpdr-code').value = clean;
  saveXpdrState();
  return true;
}

function handleSquawkInput(event) {
  // Send the code as soon as four valid digits are entered, matching the
  // lightweight behavior expected from a compact pilot-client panel.
  const clean = normalizeSquawk(event.target.value);
  if (event.target.value !== clean) event.target.value = clean;
  if (clean.length === 4 && clean !== state.squawk) sendSquawk(clean);
}

function restoreSquawkInput() {
  // Partial squawk edits are discarded on blur so the panel never displays
  // an ambiguous transponder code.
  const input = $('xpdr-code');
  if (normalizeSquawk(input.value).length !== 4) input.value = state.squawk;
}

function setXpdrMode(mode) {
  // PilotCore currently exposes mode as a toggle packet. The UI tracks the
  // requested state locally and sends one toggle when switching side.
  if (mode !== 'stby' && mode !== 'alt') return;
  if (state.xpdrMode !== mode) send({ action: 'sim_xpdr', mode });
  state.xpdrMode = mode;
  saveXpdrState();
  renderXpdrMode();
}

function toggleXpdrMode() {
  setXpdrMode(state.xpdrMode === 'alt' ? 'stby' : 'alt');
}

function renderXpdrMode() {
  $('xpdr-code').value = state.squawk;
  $('xpdr-stby').classList.toggle('active', state.xpdrMode === 'stby');
  $('xpdr-alt').classList.toggle('active', state.xpdrMode === 'alt');
}

function sendIdentUi() {
  // IDENT is momentary: the command is sent once, while the button remains
  // red for five seconds to mirror PilotUI's visual feedback.
  if (!send({ action: 'sim_ident' })) return;
  const button = $('xpdr-ident');
  button.classList.add('active');
  clearTimeout(state.identTimer);
  state.identTimer = setTimeout(() => button.classList.remove('active'), 5000);
}

function updateCommandMenu() {
  // Suggestions appear only while editing the first command token. Once the
  // user starts typing arguments, the menu stays out of the way.
  const input = $('message-input');
  const query = commandQuery(input);
  if (query === null) return hideCommandMenu();

  const matches = COMMAND_SUGGESTIONS
    .filter(command => command.name.startsWith(query))
    .sort((a, b) => Number(b.name === query) - Number(a.name === query));

  if (query !== state.commandQueryText) {
    state.commandIndex = 0;
    state.commandQueryText = query;
  }
  state.commandMatches = matches;
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, matches.length - 1));
  renderCommandMenu();
}

function commandQuery(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const beforeCursor = input.value.slice(0, cursor);
  if (!beforeCursor.startsWith('.')) return null;
  if (/\s/.test(beforeCursor)) return null;
  return beforeCursor.toLowerCase();
}

function renderCommandMenu() {
  const menu = $('command-menu');
  if (!state.commandMatches.length) {
    hideCommandMenu();
    return;
  }

  menu.innerHTML = state.commandMatches.map((command, index) => `
    <button type="button" class="command-option${index === state.commandIndex ? ' active' : ''}" data-command-index="${index}" role="option" aria-selected="${index === state.commandIndex ? 'true' : 'false'}">
      <span class="command-name">${enc(command.name)}</span>
      <span class="command-detail">${command.args ? `<span class="command-args">${enc(command.args)}</span> - ` : ''}${enc(command.description)}</span>
    </button>`).join('');
  menu.classList.remove('hidden');
  scrollActiveCommandIntoView(menu);
}

function scrollActiveCommandIntoView(menu = $('command-menu')) {
  // Arrow navigation changes the active item even when it is outside the
  // visible part of the menu. Move only the menu scroll position, not the
  // whole page, so the composer stays fixed.
  const active = menu.querySelector('.command-option.active');
  if (!active) return;

  const activeTop = active.offsetTop;
  const activeBottom = activeTop + active.offsetHeight;
  const visibleTop = menu.scrollTop;
  const visibleBottom = visibleTop + menu.clientHeight;

  if (activeTop < visibleTop) {
    menu.scrollTop = activeTop;
  } else if (activeBottom > visibleBottom) {
    menu.scrollTop = activeBottom - menu.clientHeight;
  }
}

function hideCommandMenu() {
  state.commandMatches = [];
  state.commandIndex = 0;
  state.commandQueryText = '';
  $('command-menu').classList.add('hidden');
  $('command-menu').innerHTML = '';
}

function commandMenuOpen() {
  return state.commandMatches.length > 0 && !$('command-menu').classList.contains('hidden');
}

function moveCommandSelection(delta) {
  if (!state.commandMatches.length) return;
  const last = state.commandMatches.length - 1;
  state.commandIndex = Math.max(0, Math.min(last, state.commandIndex + delta));
  renderCommandMenu();
}

function applyCommandSuggestion(index = state.commandIndex) {
  const command = state.commandMatches[index];
  if (!command) return false;

  const input = $('message-input');
  const cursor = input.selectionStart ?? input.value.length;
  const afterCursor = input.value.slice(cursor).replace(/^\s*/, '');
  const completion = `${command.name} `;
  input.value = completion + afterCursor;
  input.setSelectionRange(completion.length, completion.length);
  hideCommandMenu();
  input.focus();
  return true;
}

function handleComposerKeydown(event) {
  if (commandMenuOpen()) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCommandSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveCommandSelection(-1);
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      applyCommandSuggestion();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideCommandMenu();
      return;
    }
  }

  if (event.key === 'Tab' && commandQuery(event.target) !== null) {
    event.preventDefault();
    updateCommandMenu();
    applyCommandSuggestion();
    return;
  }

  if (event.key === 'Enter') submitMessage();
}

// Local chat and commands. METAR/TAF use the FSD form accepted by Altitude.
function submitMessage() {
  // A leading dot stays local and becomes a structured proxy command. Any
  // other text is sent as FSD chat to the selected recipient.
  const input = $('message-input');
  const text = input.value.trim();
  if (!text || !canSubmitMessage()) return;

  if (text.startsWith('.')) {
    if (runCommand(text)) {
      input.value = '';
      hideCommandMenu();
    }
    return;
  }

  const recipient = getRecipient();
  if (send({ action: 'send_message', recipient, text })) {
    input.value = '';
    hideCommandMenu();
  }
}

function canSubmitMessage() {
  // Local mode waits for the proxy/FSD connection. Remote mode can submit
  // once an agent is paired, because the relay may not have replayed the
  // latest agent.status yet even though commands can already route.
  return state.remote.enabled ? Boolean(state.remoteSelectedDeviceId) : state.connected;
}

function runCommand(text) {
  // Commands intentionally mirror common pilot-client shortcuts while still
  // emitting the same backend actions as buttons/selects.
  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const arg = (parts.shift() || '').toUpperCase();
  const rest = parts.join(' ');

  if ((cmd === 'metar' || cmd === 'wx') && arg) return sendRawWeather(0, arg, 'METAR');
  if (cmd === 'taf' && arg) return sendRawWeather(1, arg, 'TAF');
  if (cmd === 'atis' && arg) {
    send({ action: 'atis_request', callsign: arg });
    addLocal(`ATIS requested: ${arg}`);
    return true;
  }
  if ((cmd === 'msg' || cmd === 'm') && arg && rest) {
    send({ action: 'send_message', recipient: arg, text: rest });
    return true;
  }
  if (cmd === 'chat') {
    if (!arg) {
      addLocal('Usage: .chat CALLSIGN');
      return true;
    }
    openPrivateChat(arg);
    if (rest) send({ action: 'send_message', recipient: arg, text: rest });
    return true;
  }
  if (cmd === 'c1' && arg) {
    tuneCom(1, arg);
    return true;
  }
  if (cmd === 'c2' && arg) {
    tuneCom(2, arg);
    return true;
  }
  if ((cmd === 'x' || cmd === 'sq') && arg) {
    if (!sendSquawk(arg)) addLocal('Usage: .x 7000');
    return true;
  }
  if (cmd === 'xpdr' || cmd === 'xp') {
    toggleXpdrMode();
    return true;
  }
  if (cmd === 'ident' || cmd === 'id') {
    sendIdentUi();
    return true;
  }

  addLocal(`Unknown command: .${cmd}`);
  return true;
}

function sendRawWeather(type, icao, label) {
  // METAR/TAF stay as typed requests so local and remote modes share the
  // same high-level intent. The local agent translates them to FSD.
  send({ action: 'weather_request', kind: type === 1 ? 'taf' : 'metar', icao });
  addLocal(`${label} requested: ${icao}`);
  return true;
}

function getRecipient() {
  // Private tabs lock the recipient to that peer. Other tabs use the
  // selector, with Custom converting frequencies to FSD @frequency format.
  if (state.filter === 'private-peer' && state.privatePeer) return state.privatePeer;
  const value = $('recipient').value;
  if (value.startsWith('private:')) return value.slice(8);
  if (value !== 'custom') return value;
  const custom = prompt('Recipient or frequency, for example EDGG_CTR or 122.800');
  if (!custom) return '@22800';
  const freq = custom.match(/^1(\d{2})\.(\d{3})$/);
  return freq ? `@${freq[1]}${freq[2]}` : custom.toUpperCase();
}

function weatherInterpretationHtml(msg) {
  const sender = String(msg.sender || '').toUpperCase();
  const interpreter = sender === 'METAR'
    ? window.VoxHFWeather?.interpretMetar
    : sender === 'TAF'
      ? window.VoxHFWeather?.interpretTaf
      : null;
  if (!interpreter) return '';
  const interpreted = interpreter(msg.text);
  if (!interpreted) return '';
  const id = msg.messageId || '';
  const expanded = state.weatherExpanded.has(id);
  const rows = interpreted.rows.map(row => `
    <div class="metar-row" title="${enc(row.hint || '')}">
      <span>${enc(row.label)}</span>
      <strong>${enc(row.value)}</strong>
    </div>`).join('');
  return `
    <div class="metar-interpretation">
      <button class="metar-toggle" type="button" data-message-id="${enc(id)}" aria-expanded="${expanded ? 'true' : 'false'}">
        <span>Interpret</span>
        <span class="metar-caret" aria-hidden="true">&gt;</span>
      </button>
      <div class="metar-panel${expanded ? '' : ' hidden'}">${rows}</div>
    </div>`;
}

function renderWeatherPanel() {
  const panel = $('weather-panel');
  if (!panel) return;
  const slots = [
    ['departure', state.weatherState.departure],
    ['destination', state.weatherState.destination],
  ];
  const hasFlightPlan = state.flightPlanStatus === 'filed'
    && slots.some(([, slot]) => normalizeIcao(slot?.icao));

  if (!hasFlightPlan) {
    panel.innerHTML = '<div class="weather-card empty">No flight plan weather yet.</div>';
    return;
  }

  panel.innerHTML = slots
    .filter(([, slot]) => normalizeIcao(slot?.icao))
    .map(([role, slot]) => weatherCardHtml(role, slot))
    .join('');
}

function weatherCardHtml(role, slot) {
  const title = role === 'destination' ? 'Destination' : 'Departure';
  return `
    <div class="weather-card">
      <div class="weather-card-head">
        <span class="weather-role">${title}</span>
        <span class="weather-icao">${enc(slot.icao)}</span>
      </div>
      ${weatherItemHtml(role, 'metar', slot.icao, slot.metar)}
      ${weatherItemHtml(role, 'taf', slot.icao, slot.taf)}
    </div>`;
}

function weatherItemHtml(role, kind, icao, entry) {
  const label = kind.toUpperCase();
  const pending = isWeatherRequestPending(role, kind);
  const requestButton = weatherRequestButtonHtml(role, kind, icao, pending);
  if (!entry?.text) {
    return `
      <div class="weather-item">
        <div class="weather-item-head">
          <span>${label}</span>
          <span class="weather-item-meta"><span>${pending ? 'Requesting...' : 'Waiting'}</span>${requestButton}</span>
        </div>
        <div class="weather-empty">No ${label} received yet.</div>
      </div>`;
  }
  const age = weatherReceivedLabel(entry.receivedAt);
  const meta = `${enc(entry.source || 'IVAO')}${age ? ` &middot; ${enc(age)}` : ''}`;
  return `
    <div class="weather-item">
      <div class="weather-item-head">
        <span>${label}</span>
        <span class="weather-item-meta"><span>${meta}</span>${requestButton}</span>
      </div>
      <div class="weather-raw">${enc(entry.text)}</div>
      ${weatherInterpretationHtml({
        sender: label,
        text: entry.text,
        messageId: `weather-${role}-${kind}`,
      })}
    </div>`;
}

function weatherRequestButtonHtml(role, kind, icao, pending) {
  const code = normalizeIcao(icao);
  if (!code) return '';
  return `<button class="weather-request" type="button" data-weather-request="1" data-weather-role="${enc(role)}" data-weather-kind="${enc(kind)}" data-weather-icao="${enc(code)}"${pending ? ' disabled' : ''}>${pending ? 'Requesting...' : 'Request'}</button>`;
}

function weatherReceivedLabel(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

function flightPlanLabel() {
  if (state.flightPlanStatus !== 'filed') return 'No flight plan';
  if (state.flightPlan.departure && state.flightPlan.destination) {
    return `${state.flightPlan.departure} -> ${state.flightPlan.destination}`;
  }
  return 'Flight plan';
}

function requestPanelWeather(role, kind, icao) {
  const code = normalizeIcao(icao);
  if (!code) return;
  const cleanRole = role === 'destination' ? 'destination' : 'departure';
  const cleanKind = kind === 'taf' ? 'taf' : 'metar';
  if (isWeatherRequestPending(cleanRole, cleanKind)) return;
  const sent = send({
    action: 'weather_request',
    kind: cleanKind,
    icao: code,
    source: 'panel',
    role: cleanRole,
  });
  if (sent) markWeatherRequestPending(cleanRole, cleanKind);
}

function weatherRequestKey(role, kind) {
  return `${role === 'destination' ? 'destination' : 'departure'}:${kind === 'taf' ? 'taf' : 'metar'}`;
}

function isWeatherRequestPending(role, kind) {
  return state.weatherPending.has(weatherRequestKey(role, kind));
}

function markWeatherRequestPending(role, kind) {
  const key = weatherRequestKey(role, kind);
  clearWeatherRequestPending(role, kind, false);
  const cleanRole = role === 'destination' ? 'destination' : 'departure';
  const cleanKind = kind === 'taf' ? 'taf' : 'metar';
  const timeoutId = setTimeout(() => {
    state.weatherPending.delete(key);
    renderWeatherPanel();
  }, WEATHER_REQUEST_TIMEOUT_MS);
  state.weatherPending.set(key, {
    timeoutId,
    previousSignature: weatherEntrySignature(state.weatherState?.[cleanRole]?.[cleanKind]),
  });
  renderWeatherPanel();
}

function clearWeatherRequestPending(role, kind, render = true) {
  const key = weatherRequestKey(role, kind);
  const pending = state.weatherPending.get(key);
  if (pending?.timeoutId) clearTimeout(pending.timeoutId);
  const changed = state.weatherPending.delete(key);
  if (changed && render) renderWeatherPanel();
}

function clearResolvedWeatherRequests(weatherState) {
  for (const role of ['departure', 'destination']) {
    for (const kind of ['metar', 'taf']) {
      const pending = state.weatherPending.get(weatherRequestKey(role, kind));
      if (pending && weatherEntrySignature(weatherState?.[role]?.[kind]) !== pending.previousSignature) {
        clearWeatherRequestPending(role, kind, false);
      }
    }
  }
}

function weatherEntrySignature(entry) {
  if (!entry?.text) return '';
  return `${entry.receivedAt || ''}|${entry.text || ''}`;
}

function clearAllWeatherRequests(render = true) {
  for (const pending of state.weatherPending.values()) {
    if (pending?.timeoutId) clearTimeout(pending.timeoutId);
  }
  const changed = state.weatherPending.size > 0;
  state.weatherPending.clear();
  if (changed && render) renderWeatherPanel();
}

function addMessage(msg) {
  // Incoming and outgoing private messages are normalized with a privatePeer
  // key so a conversation can be rendered as one tab regardless of direction.
  if (!msg || msg.kind !== 'message') return;
  if (!msg.messageId) msg.messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const peer = privatePeerForMessage(msg);
  if (peer) {
    msg.privatePeer = peer;
    rememberPrivatePeer(peer, msg.direction !== 'outgoing');
  }
  state.messages.push(msg);
  if (state.messages.length > 400) state.messages.shift();
  renderMessages();
}

function addLocal(text) {
  // Local feedback is stored as a normal message so filtering rules apply
  // exactly like they do for server messages.
  addMessage({
    kind: 'message',
    type: 'system',
    sender: 'LOCAL',
    text,
    direction: 'outgoing',
    timestamp: new Date().toISOString(),
  });
}

function addErrorMessage(text) {
  // The Web TX readiness reminder is useful but repetitive. Show it briefly,
  // fade it out, then remove it from the in-memory chat history.
  if (text === 'Join a voice channel first. If Web TX is still not ready, press the real Altitude PTT once.') {
    addTransientLocal(text, 8000, 1000);
    return;
  }
  addLocal(text);
}

function addVoiceTxFeedback(text) {
  // TX button state is already visible in the UI. Only real COM start
  // feedback is briefly shown; monitor and PTT-up noise stays out of chat.
  if (/^TX COM[12] active$/i.test(text)) {
    addTransientLocal(text, 5000, 1000);
    return;
  }
  addLocal(text);
}

function addTransientLocal(text, visibleMs = 8000, fadeMs = 1000) {
  const id = `local-${++state.transientSeq}`;
  state.messages = state.messages.filter(msg => !(msg.transient && msg.text === text));
  addMessage({
    kind: 'message',
    type: 'system',
    sender: 'LOCAL',
    text,
    direction: 'outgoing',
    timestamp: new Date().toISOString(),
    transient: true,
    transientId: id,
  });

  setTimeout(() => {
    const msg = state.messages.find(item => item.transientId === id);
    if (!msg) return;
    msg.fading = true;
    renderMessages();
  }, visibleMs);

  setTimeout(() => {
    state.messages = state.messages.filter(item => item.transientId !== id);
    renderMessages();
  }, visibleMs + fadeMs);
}

function renderMessages() {
  // Rendering is intentionally full-list and small-bounded. With a 400 item
  // cap this keeps the code simpler than maintaining incremental DOM state.
  const box = $('messages');
  const filtered = state.messages.filter(messageMatchesCurrentTab);
  box.innerHTML = '';
  if (!filtered.length) {
    box.innerHTML = '<div class="empty">No messages.</div>';
    return;
  }
  for (const msg of filtered) {
    const row = document.createElement('div');
    const outgoing = msg.direction === 'outgoing';
    row.className = `msg ${outgoing ? 'outgoing' : msg.type || ''}${msg.fading ? ' fading' : ''}`;
    const date = new Date(msg.timestamp || Date.now());
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const to = outgoing && msg.recipient ? ` -> ${msg.recipient}` : '';
    const weather = weatherInterpretationHtml(msg);
    row.innerHTML = `
      <div class="msg-head">
        <span>${hh}:${mm}Z</span>
        <span class="msg-from">${enc(msg.sender || 'SERVER')}${enc(to)}</span>
      </div>
      <div class="msg-text">${enc(msg.text || '')}</div>
      ${weather}`;
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

function toggleWeatherInterpretation(messageId) {
  if (!messageId) return;
  if (state.weatherExpanded.has(messageId)) state.weatherExpanded.delete(messageId);
  else state.weatherExpanded.add(messageId);
  renderMessages();
  renderWeatherPanel();
}

function normalizeCallsign(value) {
  // Callsign normalization prevents duplicate private tabs caused by casing
  // or punctuation differences.
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

function privatePeerForMessage(msg) {
  // A private message can be outgoing or incoming. The peer is whichever
  // side is not our callsign.
  if (!msg || msg.type !== 'private') return '';
  if (msg.privatePeer) return msg.privatePeer;
  const own = normalizeCallsign(state.callsign);
  const sender = normalizeCallsign(msg.sender);
  const recipient = normalizeCallsign(msg.recipient);
  if (msg.direction === 'outgoing') return recipient;
  if (sender && sender !== own) return sender;
  if (recipient && recipient !== own) return recipient;
  return sender || recipient;
}

function rememberPrivatePeer(peer, incoming = false) {
  // Private chat metadata is intentionally minimal: unread count plus the
  // existence of the peer in the map.
  const callsign = normalizeCallsign(peer);
  if (!callsign || callsign.startsWith('@') || callsign === '*' || callsign === 'SERVER') return;
  const current = state.privatePeers.get(callsign) || { unread: 0 };
  if (incoming && !(state.filter === 'private-peer' && state.privatePeer === callsign)) current.unread += 1;
  state.privatePeers.set(callsign, current);
  renderPrivateTabs();
}

function openPrivateChat(peer) {
  // .chat CALLSIGN and incoming private messages both flow through this
  // model, so there is one way to create/select a private tab.
  const callsign = normalizeCallsign(peer);
  if (!callsign) return;
  rememberPrivatePeer(callsign, false);
  setActiveChatFilter('private-peer', callsign);
  $('message-input').focus();
}

function setActiveChatFilter(filter, peer = '') {
  // Changing tabs is model-first: update state, reset unread for selected
  // peer, then re-render tabs/composer/messages from that state.
  state.filter = filter;
  state.privatePeer = filter === 'private-peer' ? normalizeCallsign(peer) : '';
  if (state.privatePeer && state.privatePeers.has(state.privatePeer)) {
    state.privatePeers.get(state.privatePeer).unread = 0;
  }
  renderPrivateTabs();
  updateChatTabs();
  updateComposerContext();
  renderMessages();
}

function renderPrivateTabs() {
  // Private tabs are derived from known peers, not stored as DOM state.
  // Closing a tab removes the related conversation from memory.
  const tabs = document.querySelector('.tabs');
  const systemTab = tabs.querySelector('[data-filter="system"]');
  tabs.querySelectorAll('.private-peer-tab').forEach(tab => tab.remove());

  for (const callsign of [...state.privatePeers.keys()].sort()) {
    const meta = state.privatePeers.get(callsign) || {};
    const button = document.createElement('button');
    button.className = `tab private-peer-tab${meta.unread ? ' unread' : ''}`;
    button.dataset.filter = 'private-peer';
    button.dataset.peer = callsign;
    button.innerHTML = `
      <span>${enc(meta.unread ? `${callsign} (${meta.unread})` : callsign)}</span>
      <span class="tab-close" data-close-peer="${enc(callsign)}" title="Close chat">x</span>`;
    tabs.insertBefore(button, systemTab);
  }
  updateChatTabs();
}

function updateChatTabs() {
  // Active styling is derived from state instead of event order. This keeps
  // dynamically created private tabs consistent after close actions.
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.filter === state.filter
      && (state.filter !== 'private-peer' || tab.dataset.peer === state.privatePeer);
    tab.classList.toggle('active', active);
  });
}

function updateComposerContext() {
  // In a private tab the recipient is locked and inserted as a temporary
  // select option. Leaving the tab removes that option.
  const select = $('recipient');
  let option = select.querySelector('option[data-private-peer]');
  if (state.filter === 'private-peer' && state.privatePeer) {
    if (!option) {
      option = document.createElement('option');
      option.dataset.privatePeer = '1';
      select.prepend(option);
    }
    option.value = `private:${state.privatePeer}`;
    option.textContent = `Private: ${state.privatePeer}`;
    select.value = option.value;
    select.disabled = true;
    $('message-input').placeholder = `Private message to ${state.privatePeer}`;
    return;
  }

  if (option) option.remove();
  select.disabled = false;
  if (select.value.startsWith('private:')) select.value = '@22800';
  $('message-input').placeholder = 'Message or command: .metar LIMC, .taf LIRF, .chat CALLSIGN';
}

function messageMatchesCurrentTab(msg) {
  // All filtering decisions live here so render and private-close behavior
  // cannot disagree about what the active tab contains.
  if (state.filter === 'all') return true;
  if (state.filter === 'private-peer') return msg.type === 'private' && privatePeerForMessage(msg) === state.privatePeer;
  return msg.type === state.filter;
}

function closePrivateChat(peer) {
  // Closing a private chat is definitive for the in-memory session.
  const callsign = normalizeCallsign(peer);
  if (!callsign) return;
  state.messages = state.messages.filter(msg => !(msg.type === 'private' && privatePeerForMessage(msg) === callsign));
  state.privatePeers.delete(callsign);
  if (state.filter === 'private-peer' && state.privatePeer === callsign) {
    state.filter = 'private';
    state.privatePeer = '';
  }
  renderPrivateTabs();
  updateChatTabs();
  updateComposerContext();
  renderMessages();
}

// Web TX is deliberately isolated: if it fails, RX/chat/radio keep working.
async function startTx(com, monitorOnly = false, holdSeq = state.txStartSeq) {
  // The browser sends raw PCM, not Speex. The proxy owns encoding and TS2
  // packet shaping so codec settings stay in config.json.
  if (!monitorOnly && (!state.webTxEnabled || !state.txReady)) {
    addErrorMessage(state.webTxEnabled
      ? 'Join a voice channel first. If Web TX is still not ready, press the real Altitude PTT once.'
      : 'Web TX is disabled in config.json.');
    state.micStatus = state.webTxEnabled ? 'Waiting for voice channel' : 'TX unavailable';
    updateSettingsView();
    return;
  }

  if (state.tx?.tailTimer) {
    // A quick re-press during the release tail should continue the existing
    // microphone stream instead of tearing it down and reopening it.
    clearTimeout(state.tx.tailTimer);
    state.tx.tailTimer = null;
    state.micStatus = state.tx.monitorOnly ? 'Monitor active' : `TX COM${state.tx.com} active`;
    setTxUi(true, state.tx.com, state.tx.monitorOnly);
    updateSettingsView();
    return;
  }
  if (state.tx) return;
  if (!isTxHoldCurrent(holdSeq)) return;

  let pending = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const ctx = new AudioContext({ sampleRate: state.txSampleRate });
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    pending = { stream, ctx, source, node };

    if (!isTxHoldCurrent(holdSeq)) {
      releaseTxResources(pending);
      state.micStatus = 'Released';
      updateSettingsView();
      return;
    }

    state.tx = { com, monitorOnly, stream, ctx, source, node };
    pending = null;
    state.micStatus = monitorOnly ? 'Monitor active' : `TX COM${com} active`;
    updateSettingsView();
    setTxUi(true, com, monitorOnly);
    if (!send({ action: monitorOnly ? 'voice_tx_monitor_start' : 'voice_tx_start', com })) {
      stopTx({ immediate: true });
      state.micStatus = monitorOnly ? 'Monitor unavailable' : 'TX unavailable';
      updateSettingsView();
      return;
    }

    node.onaudioprocess = event => {
      // ScriptProcessor is old but broadly available and simple. Each block
      // is resampled, converted to PCM16, prefixed, and pushed to the proxy.
      if (!state.tx || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatsToPcm16(resample(event.inputBuffer.getChannelData(0), ctx.sampleRate, state.txSampleRate));
      const packet = new Uint8Array(4 + pcm.byteLength);
      packet.set(TX_PACKET_MAGIC, 0);
      packet.set(new Uint8Array(pcm.buffer), 4);
      state.ws.send(packet.buffer);
    };

    source.connect(node);
    node.connect(ctx.destination);
  } catch (err) {
    if (pending) releaseTxResources(pending);
    state.micStatus = `Unavailable: ${err.message || err}`;
    updateSettingsView();
    addLocal(`Microphone unavailable: ${err.message || err}`);
    stopTx({ immediate: true });
    state.micStatus = `Unavailable: ${err.message || err}`;
    updateSettingsView();
  }
}

function stopTx(options = {}) {
  // On a normal PTT release, keep the stream alive briefly so the final
  // syllable reaches the encoder before tx.stop closes the session.
  state.txHoldActive = false;
  state.txStartSeq += 1;
  if (!state.tx) return;
  const tx = state.tx;
  if (!options.immediate && !tx.monitorOnly) {
    if (tx.tailTimer) return;
    state.micStatus = 'Finishing TX';
    tx.tailTimer = setTimeout(() => finishTx(tx), TX_RELEASE_TAIL_MS);
    updateSettingsView();
    return;
  }
  finishTx(tx);
}

function isTxHoldCurrent(holdSeq) {
  // getUserMedia() can resolve after the finger/mouse has already released the
  // PTT. The sequence check prevents iOS from starting a late microphone stream
  // that would leave the button stuck ON AIR.
  return state.txHoldActive && holdSeq === state.txStartSeq;
}

function finishTx(tx) {
  // Release every browser resource after the optional tail. This avoids a
  // hidden tab keeping the microphone open after transmission stops.
  if (state.tx !== tx) return;
  if (tx.tailTimer) clearTimeout(tx.tailTimer);
  state.tx = null;
  state.micStatus = 'Released';
  setTxUi(false);
  send({ action: 'voice_tx_stop' });
  releaseTxResources(tx);
  updateSettingsView();
}

function releaseTxResources(tx) {
  // Every TX/monitor path owns a small browser audio graph. Cleanup is shared
  // so early-aborted iOS permission flows and normal releases behave the same.
  try { tx.node.disconnect(); } catch (_) {}
  try { tx.source.disconnect(); } catch (_) {}
  try { tx.ctx.close(); } catch (_) {}
  tx.stream.getTracks().forEach(track => track.stop());
}

function setTxUi(active, com, monitorOnly = false) {
  // The radio TX buttons and the Settings monitor button share one live
  // state, but each control renders its own label.
  const activeCom = com || state.tx?.com || '';
  const activeMonitor = monitorOnly || state.tx?.monitorOnly || false;
  for (const id of TX_BUTTON_IDS) {
    const button = $(id);
    const mine = active && !activeMonitor && id === `tx${activeCom}`;
    button.classList.toggle('active', mine);
    button.textContent = mine ? 'ON AIR' : `TX COM${id.slice(2)}`;
  }
  const settingsMonitor = $('settings-monitor-tx');
  if (settingsMonitor) {
    settingsMonitor.classList.toggle('active', active && activeMonitor);
    settingsMonitor.textContent = active && activeMonitor ? 'MONITOR' : 'Monitor TX';
  }
}

function resample(input, fromRate, toRate) {
  // Linear interpolation is enough here because the proxy/ffmpeg handles the
  // codec work; this only adapts browser device rate to the configured TX rate.
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(input.length - 1, a + 1);
    const t = pos - a;
    out[i] = input[a] + (input[b] - input[a]) * t;
  }
  return out;
}

function floatsToPcm16(input) {
  // A small soft limiter gives the Speex encoder usable level without
  // hard clipping browser microphone peaks.
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, Math.tanh(input[i] * 4)));
    out[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return out;
}

function bindUi() {
  // Binding is centralized so markup stays declarative and all actions point
  // back to the same model functions used by commands.
  bindAudioUnlock();
  $('theme-toggle').onclick = toggleTheme;
  $('send').onclick = submitMessage;
  $('settings-open').onclick = () => openSettings();
  $('update-dismiss').onclick = dismissUpdateNotice;
  $('overlay-remote-settings').onclick = () => openSettings('remote');
  $('settings-close').onclick = closeSettings;
  $('settings-modal').addEventListener('mousedown', event => {
    if (event.target === $('settings-modal')) closeSettings();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) closeSettings();
  });
  document.querySelector('.settings-tabs').onclick = event => {
    const button = event.target.closest('[data-settings-tab]');
    if (!button) return;
    state.activeSettingsTab = button.dataset.settingsTab;
    renderSettingsTab();
    updateSettingsView();
  };
  $('message-input').addEventListener('keydown', handleComposerKeydown);
  $('message-input').addEventListener('input', updateCommandMenu);
  $('message-input').addEventListener('focus', updateCommandMenu);
  $('message-input').addEventListener('blur', () => setTimeout(hideCommandMenu, 120));
  $('messages').addEventListener('click', event => {
    const toggle = event.target.closest('.metar-toggle[data-message-id]');
    if (!toggle) return;
    toggleWeatherInterpretation(toggle.dataset.messageId);
  });
  $('weather-panel').addEventListener('click', event => {
    const request = event.target.closest('[data-weather-request]');
    if (request) {
      requestPanelWeather(request.dataset.weatherRole, request.dataset.weatherKind, request.dataset.weatherIcao);
      return;
    }
    const toggle = event.target.closest('.metar-toggle[data-message-id]');
    if (!toggle) return;
    toggleWeatherInterpretation(toggle.dataset.messageId);
  });
  $('command-menu').addEventListener('mousedown', event => {
    const option = event.target.closest('[data-command-index]');
    if (!option) return;
    event.preventDefault();
    applyCommandSuggestion(Number(option.dataset.commandIndex));
  });
  $('com1-input').oninput = event => handleComInput(1, event);
  $('com2-input').oninput = event => handleComInput(2, event);
  $('com1-input').onfocus = event => event.target.select();
  $('com2-input').onfocus = event => event.target.select();
  $('com1-input').onblur = () => restoreComInput(1);
  $('com2-input').onblur = () => restoreComInput(2);
  $('com1-select').onchange = event => event.target.value && tuneStation(1, stationByCallsign(event.target.value));
  $('com2-select').onchange = event => event.target.value && tuneStation(2, stationByCallsign(event.target.value));
  $('xpdr-code').oninput = handleSquawkInput;
  $('xpdr-code').onblur = restoreSquawkInput;
  $('xpdr-stby').onclick = () => setXpdrMode('stby');
  $('xpdr-alt').onclick = () => setXpdrMode('alt');
  $('xpdr-ident').onclick = sendIdentUi;
  renderXpdrMode();
  bindHoldButton('tx1', holdSeq => startTx(1, false, holdSeq));
  bindHoldButton('tx2', holdSeq => startTx(2, false, holdSeq));
  bindHoldButton('settings-monitor-tx', holdSeq => startTx(1, true, holdSeq));
  $('settings-test-audio').onclick = async () => {
    if (state.remote.enabled) {
      await playBrowserTestTone();
      return;
    }
    await ensureAudio();
    send({ action: 'test_audio' });
  };
  $('settings-remote-apply').onclick = applyRemoteSettings;
  $('settings-remote-check-button').onclick = runRemotePreflight;
  $('settings-remote-renew-code').onclick = renewRemotePairingCode;
  $('settings-remote-copy-code').onclick = copyRemotePairingCode;
  $('settings-remote-pair').onclick = () => confirmRemotePairing();
  $('settings-remote-forget').onclick = forgetRemotePairing;
  $('settings-remote-local').onclick = switchToLocalMode;
  $('settings-account-open').onclick = openAccountLogin;
  $('settings-account-logout').onclick = logoutAccount;
  $('settings-account-rotate-token').onclick = rotateAccountAgentToken;
  $('settings-account-refresh-sessions').onclick = () => refreshAccountSessions(true);
  $('settings-account-revoke-others').onclick = revokeOtherAccountSessions;
  $('settings-account-sessions').onclick = event => {
    const button = event.target.closest('[data-account-session-id]');
    if (button) revokeAccountSession(button.dataset.accountSessionId);
  };
  $('settings-account-password-form').onsubmit = changeAccountPassword;
  $('auth-login').onclick = loginAccount;
  $('auth-register').onclick = registerAccount;
  $('auth-manual').onclick = openManualRemoteSetup;
  $('auth-continue').onclick = continueAfterAuth;
  $('auth-account-password').addEventListener('keydown', event => {
    if (event.key === 'Enter') loginAccount();
  });
  document.querySelector('.tabs').onclick = event => {
    const target = event.target.closest ? event.target : event.target.parentElement;
    if (!target) return;
    const close = target.closest('[data-close-peer]');
    if (close) {
      event.stopPropagation();
      closePrivateChat(close.dataset.closePeer);
      return;
    }
    const button = target.closest('.tab');
    if (!button) return;
    setActiveChatFilter(button.dataset.filter, button.dataset.peer || '');
  };
}

function bindAudioUnlock() {
  if (state.audioUnlockBound) return;
  state.audioUnlockBound = true;
  const unlock = () => {
    // Mobile browsers require a user gesture before audio can play. Creating
    // and resuming the RX context on the first real interaction keeps later
    // live radio PCM from arriving into a suspended output graph.
    ensureAudio().catch(() => {});
  };
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('keydown', unlock);
}

function bindHoldButton(id, onStart) {
  // PTT buttons behave as hold-to-talk on mouse and touch. Releasing,
  // leaving, or cancelling all stop transmission.
  const button = $(id);
  let activePointerId = null;
  let lastTouchAt = 0;

  const begin = event => {
    if (event.type === 'touchstart') lastTouchAt = Date.now();
    if (event.type === 'mousedown' && Date.now() - lastTouchAt < 800) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    if (activePointerId !== null) return;
    activePointerId = event.pointerId ?? 'fallback';
    state.txHoldActive = true;
    state.txStartSeq += 1;
    onStart(state.txStartSeq);
  };

  const end = event => {
    if (event) event.preventDefault();
    if (activePointerId === null) return;
    activePointerId = null;
    state.txHoldActive = false;
    stopTx();
  };

  if (window.PointerEvent) {
    button.addEventListener('pointerdown', begin);
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('pointerleave', end);
    return;
  }

  button.addEventListener('mousedown', begin);
  button.addEventListener('mouseup', end);
  button.addEventListener('mouseleave', end);
  button.addEventListener('touchstart', begin, { passive: false });
  button.addEventListener('touchend', end, { passive: false });
  button.addEventListener('touchcancel', end, { passive: false });
}

// Automatic recovery is softer than a full page refresh: it keeps in-memory
// chat state, resets audio scheduling, and recreates only the control
// WebSocket when heartbeat detects a stale connection.
async function recoverConnection() {
  resetAudioSchedule();
  await resumeAudioIfNeeded();
  state.pongPendingSince = 0;
  connect(true);
}

function heartbeat() {
  // A pong timeout means the control WebSocket is stale even if audio is
  // still audible. Recovery reconnects the socket without wiping chat state.
  const now = Date.now();
  if (!state.ws || state.ws.readyState > WebSocket.OPEN) {
    connect(true);
    return;
  }

  if (state.ws.readyState === WebSocket.CONNECTING) {
    if (state.connectStartedAt && now - state.connectStartedAt > CONNECT_TIMEOUT_MS) recoverConnection();
    return;
  }

  if (state.ws.readyState !== WebSocket.OPEN) return;

  if (!state.pongPendingSince && state.lastPongAt && now - state.lastPongAt > PONG_TIMEOUT_MS) {
    recoverConnection();
    return;
  }

  if (state.pongPendingSince && now - state.pongPendingSince > PONG_TIMEOUT_MS) {
    recoverConnection();
    return;
  }

  if (send({ action: 'ping', at: now }) && !state.pongPendingSince) {
    state.pongPendingSince = now;
  }
}

async function resumeFromStandby() {
  // Browser standby can leave WebSocket.readyState as OPEN even when no
  // control messages are flowing anymore. If the last pong is old, rebuild
  // the socket immediately instead of waiting for the next timeout cycle.
  await resumeAudioIfNeeded();
  const now = Date.now();
  const stale = !state.ws
    || state.ws.readyState !== WebSocket.OPEN
    || (state.lastPongAt && now - state.lastPongAt > PONG_TIMEOUT_MS);
  if (stale) recoverConnection();
  else heartbeat();
}

function initializeDemoState() {
  // Demo mode is a deterministic, credential-free rendering fixture used for
  // documentation screenshots. It never opens a network or audio connection.
  document.body.dataset.demo = '1';
  const demoPanel = PAGE_PARAMS.get('panel');
  const demoPanels = new Set(['hero', 'overview', 'controls', 'voice', 'communications', 'weather']);
  if (demoPanels.has(demoPanel)) {
    document.body.classList.add(`demo-panel-${demoPanel}`);
  }
  state.remote.enabled = PAGE_PARAMS.get('mode') === 'remote';
  state.remote.relay = state.remote.enabled ? 'wss://relay.example.test' : '';
  state.version = '0.1.0';
  state.lanIp = '192.0.2.10';
  state.callsign = 'VOX321';
  state.squawk = '2000';
  state.xpdrMode = 'alt';
  $('xpdr-code').value = state.squawk;
  renderXpdrMode();

  updateOwnPosition({ lat: 45.6301, lon: 8.7231 }, false);
  [
    { callsign: 'LIMC_TWR', freq: '128.350', lat: 45.6306, lon: 8.7281 },
    { callsign: 'LIMC_APP', freq: '126.750', lat: 45.6201, lon: 8.7021 },
    { callsign: 'LIML_TWR', freq: '118.100', lat: 45.4451, lon: 9.2767 },
    { callsign: 'LIPP_CTR', freq: '120.725', lat: 45.0522, lon: 10.0712 },
  ].forEach(station => addStation(station, false));
  setComLabel(1, '128.350', 'LIMC_TWR');
  setComLabel(2, '122.800', 'UNICOM');

  const weatherState = {
    departure: {
      icao: 'LIMC',
      metar: { text: 'LIMC 131350Z 18008KT 9999 FEW035 28/17 Q1016 NOSIG', source: 'IVAO', receivedAt: '2026-07-13T13:52:00Z' },
      taf: { text: 'TAF LIMC 131100Z 1312/1418 17008KT CAVOK TEMPO 1315/1319 4000 TSRA SCT030CB', source: 'IVAO', receivedAt: '2026-07-13T13:52:00Z' },
    },
    destination: {
      icao: 'LIRF',
      metar: { text: 'LIRF 131350Z 24012KT 9999 FEW025 30/19 Q1013 NOSIG', source: 'IVAO', receivedAt: '2026-07-13T13:52:00Z' },
      taf: { text: 'TAF LIRF 131100Z 1312/1418 23010KT CAVOK BECMG 1406/1408 17006KT', source: 'IVAO', receivedAt: '2026-07-13T13:52:00Z' },
    },
  };
  if (demoPanel === 'weather' || PAGE_PARAMS.get('weather') === 'expanded') {
    state.weatherExpanded.add('weather-departure-metar');
    state.weatherExpanded.add('weather-destination-metar');
  }
  setFlightPlanStatus('filed', { departure: 'LIMC', destination: 'LIRF', alternate: 'LIPZ' }, weatherState);

  state.messages = [
    { kind: 'message', type: 'frequency', sender: 'LIMC_TWR', text: 'VOX321, wind 180 degrees 8 knots, runway 35R cleared for takeoff.', direction: 'incoming', timestamp: '2026-07-13T14:29:00Z', messageId: 'demo-1' },
    { kind: 'message', type: 'frequency', sender: 'VOX321', recipient: '@28350', text: 'Cleared for takeoff runway 35R, VOX321.', direction: 'outgoing', timestamp: '2026-07-13T14:29:30Z', messageId: 'demo-2' },
    { kind: 'message', type: 'frequency', sender: 'LIMC_TWR', text: 'VOX321, contact Milano Departure on 126.750.', direction: 'incoming', timestamp: '2026-07-13T14:32:00Z', messageId: 'demo-3' },
    { kind: 'message', type: 'frequency', sender: 'VOX321', recipient: '@28350', text: '126.750, VOX321, good day.', direction: 'outgoing', timestamp: '2026-07-13T14:32:30Z', messageId: 'demo-4' },
    { kind: 'message', type: 'frequency', sender: 'LIMC_APP', text: 'VOX321, identified. Climb flight level 120, direct TZO.', direction: 'incoming', timestamp: '2026-07-13T14:34:00Z', messageId: 'demo-5' },
    { kind: 'message', type: 'frequency', sender: 'VOX321', recipient: '@26750', text: 'Climb flight level 120, direct TZO, VOX321.', direction: 'outgoing', timestamp: '2026-07-13T14:34:30Z', messageId: 'demo-6' },
    { kind: 'message', type: 'private', sender: 'LIMC_GND', recipient: 'VOX321', text: 'Your flight plan LIMC-LIRF is active.', direction: 'incoming', timestamp: '2026-07-13T14:35:00Z', messageId: 'demo-7', privatePeer: 'LIMC_GND' },
    { kind: 'message', type: 'system', sender: 'SYSTEM', text: 'Voice channel LIMC_APP is ready.', direction: 'incoming', timestamp: '2026-07-13T14:35:30Z', messageId: 'demo-8' },
  ];
  state.privatePeers.set('LIMC_GND', { unread: 1 });
  renderPrivateTabs();
  renderMessages();
  setWebTxStatus(true, true);
  setOnline(state.callsign);
  setControlsDisabled(false);
  $('remote-pill').classList.toggle('hidden', !state.remote.enabled);
  $('remote-mode').textContent = state.remote.enabled ? 'Remote' : 'Local';
  if (PAGE_PARAMS.get('rx') !== '0') $('rx-light').classList.add('active');
  if (demoPanel === 'voice') setTxUi(true, 1);
  if (demoPanel === 'communications') {
    $('message-input').value = '.';
    updateCommandMenu();
  }
  updateSettingsView();
}

// Standby/suspended tab: when the page becomes visible, check the control
// channel and audio context without immediately discarding a working socket.
if (!DEMO_MODE) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeFromStandby();
  });
  window.addEventListener('focus', resumeFromStandby);
  window.addEventListener('pageshow', resumeFromStandby);
  window.addEventListener('online', resumeFromStandby);
  setInterval(heartbeat, HEARTBEAT_MS);
}

applyTheme(activeTheme);
bindUi();
// Initial render keeps the app readable before the proxy connects.
setControlsDisabled(true);
updateComposerContext();
renderSettingsTab();
updateSettingsView();
renderWeatherPanel();
renderMessages();
if (DEMO_MODE) {
  initializeDemoState();
} else {
  checkForUpdates('release.json');
  refreshAccountStatus().finally(() => {
    updateAuthGate();
    connect();
  });
}
