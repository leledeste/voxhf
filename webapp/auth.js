'use strict';

const REMOTE_STORAGE_KEY = 'voxhf.remoteSettings.v1';
const ACCOUNT_STORAGE_KEY = 'voxhf.accountSettings.v1';
const params = new URLSearchParams(location.search);
const nextPage = safeNextPage(params.get('next'));
let mode = ['register', 'recover'].includes(params.get('mode')) ? params.get('mode') : 'login';
if (location.pathname.toLowerCase().endsWith('/register')) mode = 'register';
let registrationEnabled = true;
let registrationRequiresInvite = true;
let termsVersion = '1.0';
let privacyVersion = '1.0';

const elements = {
  form: document.getElementById('account-form'),
  loginTab: document.getElementById('login-tab'),
  registerTab: document.getElementById('register-tab'),
  recoverTab: document.getElementById('recover-tab'),
  title: document.getElementById('account-title'),
  copy: document.getElementById('account-copy'),
  user: document.getElementById('account-user'),
  name: document.getElementById('account-name'),
  displayNameField: document.getElementById('display-name-field'),
  inviteCodeField: document.getElementById('invite-code-field'),
  invite: document.getElementById('account-invite'),
  recoveryCodeField: document.getElementById('recovery-code-field'),
  recoveryCode: document.getElementById('account-recovery-code'),
  passwordLabel: document.getElementById('password-label'),
  password: document.getElementById('account-password'),
  confirmPasswordField: document.getElementById('confirm-password-field'),
  confirmPassword: document.getElementById('account-password-confirm'),
  legalAcceptance: document.getElementById('legal-acceptance'),
  acceptTerms: document.getElementById('accept-terms'),
  acknowledgePrivacy: document.getElementById('acknowledge-privacy'),
  termsVersion: document.getElementById('terms-version'),
  privacyVersion: document.getElementById('privacy-version'),
  submit: document.getElementById('account-submit'),
  status: document.getElementById('account-status'),
  relay: document.getElementById('relay-url'),
  tokenResult: document.getElementById('agent-token-result'),
  token: document.getElementById('agent-token'),
  copyToken: document.getElementById('copy-agent-token'),
  continueButton: document.getElementById('continue-to-app'),
};

initialize();

async function initialize() {
  elements.relay.value = savedRelayUrl() || defaultRelayUrl();
  elements.loginTab.onclick = () => setMode('login');
  elements.registerTab.onclick = () => setMode('register');
  elements.recoverTab.onclick = () => setMode('recover');
  elements.form.onsubmit = submitAccount;
  elements.copyToken.onclick = copyAgentToken;
  elements.continueButton.onclick = () => location.replace(nextPage);
  setMode(mode);
  await readAccountStatus();
}

function setMode(nextMode) {
  mode = ['register', 'recover'].includes(nextMode) ? nextMode : 'login';
  const registering = mode === 'register';
  const recovering = mode === 'recover';
  elements.loginTab.classList.toggle('active', mode === 'login');
  elements.loginTab.setAttribute('aria-selected', String(mode === 'login'));
  elements.registerTab.classList.toggle('active', registering);
  elements.registerTab.setAttribute('aria-selected', String(registering));
  elements.recoverTab.classList.toggle('active', recovering);
  elements.recoverTab.setAttribute('aria-selected', String(recovering));
  elements.displayNameField.classList.toggle('hidden', !registering);
  elements.inviteCodeField.classList.toggle('hidden', !registering || !registrationRequiresInvite);
  elements.recoveryCodeField.classList.toggle('hidden', !recovering);
  elements.confirmPasswordField.classList.toggle('hidden', !recovering);
  elements.legalAcceptance.classList.toggle('hidden', !registering);
  elements.title.textContent = registering ? 'Create your account' : recovering ? 'Recover your account' : 'Welcome back';
  elements.copy.textContent = recovering
    ? 'Use the one-time recovery code created by your relay administrator.'
    : registering
    ? registrationRequiresInvite
      ? 'Use the private invitation code provided by the relay administrator.'
      : 'Create one account for your browser devices and local agent.'
    : 'Continue to your VoxHF workspace.';
  elements.submit.textContent = registering ? 'Create account' : recovering ? 'Reset password' : 'Sign in';
  elements.passwordLabel.textContent = recovering ? 'New password' : 'Password';
  elements.password.placeholder = recovering ? 'choose a new password' : 'your password';
  elements.password.autocomplete = registering || recovering ? 'new-password' : 'current-password';
  elements.registerTab.disabled = !registrationEnabled;
  clearStatus();
}

async function readAccountStatus() {
  setStatus('Checking your session...');
  try {
    const body = await accountRequest('/account/api/status');
    registrationEnabled = Boolean(body.registrationEnabled);
    registrationRequiresInvite = body.registrationRequiresInvite !== false;
    termsVersion = String(body.legal?.termsVersion || termsVersion);
    privacyVersion = String(body.legal?.privacyVersion || privacyVersion);
    elements.termsVersion.textContent = termsVersion;
    elements.privacyVersion.textContent = privacyVersion;
    elements.registerTab.disabled = !registrationEnabled;
    elements.registerTab.title = registrationEnabled ? '' : 'Registration is disabled on this relay.';
    if (!registrationEnabled && mode === 'register') setMode('login');
    else setMode(mode);
    if (body.authenticated && body.user) {
      saveAccount(body.user);
      location.replace(nextPage);
      return;
    }
    clearStatus();
  } catch (error) {
    setStatus(accountErrorMessage(error, 'status'), 'bad');
  }
}

async function submitAccount(event) {
  event.preventDefault();
  const body = readForm();
  if (!body) return;
  setBusy(true);
  setStatus(mode === 'register' ? 'Creating your account...' : mode === 'recover' ? 'Resetting your password...' : 'Signing in...');
  try {
    const endpoint = mode === 'recover' ? '/account/api/password/recover' : `/account/api/${mode}`;
    const result = await accountRequest(endpoint, {
      method: 'POST',
      body,
    });
    saveRemoteRelay();
    saveAccount(result.user);
    if (mode === 'register') {
      elements.token.value = result.agentToken || '';
      elements.tokenResult.classList.remove('hidden');
      elements.form.classList.add('hidden');
      document.querySelector('.account-tabs').classList.add('hidden');
      setStatus('Account created. Save the agent token before continuing.', 'good');
    } else {
      setStatus(mode === 'recover' ? 'Password reset. Opening your workspace...' : 'Signed in. Opening your workspace...', 'good');
      location.replace(nextPage);
    }
  } catch (error) {
    setStatus(accountErrorMessage(error, mode), 'bad');
  } finally {
    setBusy(false);
  }
}

function readForm() {
  const userId = elements.user.value.trim().toLowerCase();
  const password = elements.password.value;
  if (!/^[a-z0-9._-]{2,48}$/.test(userId)) {
    setStatus('Use 2-48 letters, numbers, dots, underscores or dashes.', 'bad');
    return null;
  }
  if (!password) {
    setStatus('Enter your password.', 'bad');
    return null;
  }
  if (mode === 'register' && password.length < 10) {
    setStatus('Password must be at least 10 characters.', 'bad');
    return null;
  }
  const body = mode === 'recover' ? { userId, newPassword: password } : { userId, password };
  if (mode === 'register') {
    body.displayName = elements.name.value.trim() || userId;
    if (registrationRequiresInvite) {
      const inviteCode = elements.invite.value.trim().toUpperCase();
      if (!inviteCode) {
        setStatus('Enter the invitation code provided by the relay administrator.', 'bad');
        return null;
      }
      body.inviteCode = inviteCode;
    }
    if (!elements.acceptTerms.checked || !elements.acknowledgePrivacy.checked) {
      setStatus('Accept the Terms and confirm that you have read the Privacy Policy.', 'bad');
      return null;
    }
    body.acceptTerms = true;
    body.acknowledgePrivacy = true;
    body.termsVersion = termsVersion;
    body.privacyVersion = privacyVersion;
  }
  if (mode === 'recover') {
    const recoveryCode = elements.recoveryCode.value.trim().toUpperCase();
    if (!recoveryCode) {
      setStatus('Enter the recovery code provided by the relay administrator.', 'bad');
      return null;
    }
    if (password.length < 10) {
      setStatus('Password must be at least 10 characters.', 'bad');
      return null;
    }
    if (password !== elements.confirmPassword.value) {
      setStatus('The new passwords do not match.', 'bad');
      return null;
    }
    body.recoveryCode = recoveryCode;
  }
  return body;
}

async function accountRequest(pathname, options = {}) {
  const relay = normalizeRelayUrl(elements.relay.value);
  if (!relay) throw codedError('invalid_relay', 'Enter a valid HTTPS or WSS relay URL.');
  const url = new URL(pathname, relay);
  const response = await fetch(url, {
    method: options.method || 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw codedError(body.code, body.error || `HTTP ${response.status}`);
  }
  return body;
}

function normalizeRelayUrl(value) {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (location.protocol === 'https:' && url.protocol !== 'https:') return '';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function defaultRelayUrl() {
  const host = location.hostname.replace(/^app\./i, 'relay.');
  return `${location.protocol === 'http:' ? 'http:' : 'https:'}//${host}`;
}

function savedRelayUrl() {
  try {
    return JSON.parse(localStorage.getItem(REMOTE_STORAGE_KEY) || '{}').relay || '';
  } catch (_) {
    return '';
  }
}

function saveRemoteRelay() {
  const relay = elements.relay.value.trim();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(REMOTE_STORAGE_KEY) || '{}'); } catch (_) {}
  localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify({ ...saved, enabled: true, relay }));
}

function saveAccount(user) {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({
    userId: user?.userId || '',
    userName: user?.userName || user?.userId || '',
  }));
}

async function copyAgentToken() {
  try {
    await navigator.clipboard.writeText(elements.token.value);
    elements.copyToken.textContent = 'Copied';
  } catch (_) {
    elements.token.select();
    document.execCommand('copy');
    elements.copyToken.textContent = 'Copied';
  }
}

function accountErrorMessage(error, action) {
  switch (error?.code) {
    case 'account_mode_unavailable': return 'Accounts are not enabled on this relay.';
    case 'registration_disabled': return 'Registration is disabled. Ask the relay administrator for access.';
    case 'invalid_invite': return 'The invitation code is invalid, expired or has already been used.';
    case 'username_taken': return 'That username is already registered. Sign in or choose another one.';
    case 'invalid_username': return 'Use 2-48 letters, numbers, dots, underscores or dashes.';
    case 'invalid_display_name': return 'Display name must be 1-80 characters.';
    case 'invalid_password': return 'Password must be 10-256 characters.';
    case 'legal_acceptance_required': return 'Accept the current Terms and confirm that you have read the Privacy Policy.';
    case 'invalid_credentials': return 'Username or password is incorrect.';
    case 'invalid_recovery_code': return 'The recovery code is invalid or has expired.';
    case 'auth_rate_limited': return 'Too many attempts. Wait a few seconds and try again.';
    case 'invalid_relay': return error.message;
    default:
      if (action === 'status') return 'The relay is unavailable. Check the relay address and try again.';
      return action === 'register' ? 'Account creation failed. Try again.' : 'Sign in failed. Try again.';
  }
}

function setBusy(busy) {
  elements.submit.disabled = busy;
  elements.loginTab.disabled = busy;
  elements.registerTab.disabled = busy || !registrationEnabled;
  elements.recoverTab.disabled = busy;
  elements.acceptTerms.disabled = busy;
  elements.acknowledgePrivacy.disabled = busy;
}

function setStatus(text, tone = '') {
  elements.status.textContent = text;
  elements.status.className = `account-status${tone ? ` ${tone}` : ''}`;
}

function clearStatus() {
  setStatus('');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code || '';
  return error;
}

function safeNextPage(value) {
  const defaultPage = location.protocol === 'https:' ? '/' : 'app.html';
  if (!value) return defaultPage;
  try {
    const url = new URL(value, location.href);
    const workspacePath = url.pathname === '/' || url.pathname.endsWith('/app.html');
    if (url.origin !== location.origin || !workspacePath) return defaultPage;
    // Never carry manual access material through the account URL. Account
    // sessions use an HttpOnly cookie and do not need token query parameters.
    url.searchParams.delete('token');
    url.searchParams.delete('pair');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return defaultPage;
  }
}
