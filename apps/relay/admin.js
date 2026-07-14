'use strict';

// The admin client is deliberately a thin view layer. Authentication and every
// authorization decision live on the relay; this file only renders API state
// and sends explicit operator actions.

const state = {
  auth: null,
  status: null,
  users: [],
  devices: [],
  pairings: [],
  sessions: [],
  mfa: null,
  mfaLogin: null,
  audit: [],
  auditEnabled: false,
  view: 'overview',
};

const elements = Object.fromEntries([
  'authView', 'authTitle', 'authLead', 'authStatus', 'loginForm', 'loginUsername',
  'loginPassword', 'bootstrapForm', 'bootstrapUsername', 'bootstrapDisplayName',
  'mfaLoginPanel', 'mfaPasskeyButton', 'mfaRecoveryPanel', 'mfaRecoveryForm',
  'mfaRecoveryCode', 'mfaCancelButton',
  'bootstrapPassword', 'bootstrapToken', 'recoveryPanel', 'recoveryForm',
  'recoveryUsername', 'recoveryPassword', 'recoveryToken', 'adminApp', 'adminName',
  'adminRole', 'logoutButton', 'viewTitle', 'relayStatus', 'refreshButton',
  'overviewStats', 'overviewDetails', 'userSearch', 'usersBody', 'inviteStatus',
  'createInviteButton', 'secretReveal', 'pairingsBody', 'devicesBody',
  'revokeOthersButton', 'sessionsBody', 'passwordForm', 'currentPassword',
  'newPassword', 'confirmPassword', 'mfaStatusBadge', 'mfaUnsupported',
  'passkeysList', 'passkeyForm', 'passkeyName', 'mfaCurrentPassword',
  'addPasskeyButton', 'regenerateCodesButton', 'disableMfaButton',
  'mfaRecoveryCodes', 'systemDetails', 'auditBody', 'toast',
].map((id) => [id, document.getElementById(id)]));

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  bindEvents();
  await refreshAuthentication();
}

function bindEvents() {
  elements.loginForm.addEventListener('submit', login);
  elements.mfaPasskeyButton.addEventListener('click', completeMfaLoginWithPasskey);
  elements.mfaRecoveryForm.addEventListener('submit', completeMfaLoginWithRecoveryCode);
  elements.mfaCancelButton.addEventListener('click', cancelMfaLogin);
  elements.bootstrapForm.addEventListener('submit', bootstrapOwner);
  elements.recoveryForm.addEventListener('submit', recoverOwner);
  elements.logoutButton.addEventListener('click', logout);
  elements.refreshButton.addEventListener('click', loadDashboard);
  elements.userSearch.addEventListener('input', renderUsers);
  elements.createInviteButton.addEventListener('click', createInvite);
  elements.revokeOthersButton.addEventListener('click', revokeOtherSessions);
  elements.passwordForm.addEventListener('submit', changePassword);
  elements.passkeyForm.addEventListener('submit', addPasskey);
  elements.regenerateCodesButton.addEventListener('click', regenerateRecoveryCodes);
  elements.disableMfaButton.addEventListener('click', disableMfa);
  elements.passkeysList.addEventListener('click', removePasskey);

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => selectView(button.dataset.view));
  });

  elements.usersBody.addEventListener('click', handleUserAction);
  elements.pairingsBody.addEventListener('click', handlePairingAction);
  elements.sessionsBody.addEventListener('click', handleSessionAction);
}

async function refreshAuthentication() {
  try {
    state.auth = await api('/admin/api/auth/status', { publicRequest: true });
    elements.recoveryPanel.classList.toggle('hidden', !state.auth.breakGlassAvailable || state.auth.bootstrapRequired);

    if (state.auth.authenticated) {
      showApplication(state.auth.admin);
      await loadDashboard();
      return;
    }

    showAuthentication();
  } catch (error) {
    showAuthentication();
    setAuthStatus(error.message);
  }
}

function showAuthentication() {
  elements.adminApp.classList.add('hidden');
  elements.authView.classList.remove('hidden');
  const bootstrap = Boolean(state.auth?.bootstrapRequired);
  state.mfaLogin = null;
  elements.mfaLoginPanel.classList.add('hidden');
  elements.loginForm.classList.toggle('hidden', bootstrap || state.auth?.accountLoginAvailable === false);
  elements.bootstrapForm.classList.toggle('hidden', !bootstrap);
  elements.recoveryPanel.classList.toggle('hidden', !state.auth?.breakGlassAvailable || bootstrap);
  elements.authTitle.textContent = bootstrap ? 'Create the relay owner' : 'Sign in';
  elements.authLead.textContent = bootstrap
    ? 'Use the bootstrap token once. Future access will use this owner account.'
    : state.auth?.accountLoginAvailable === false
      ? 'Account administration requires SQLite or SQLite fallback mode.'
      : 'Manage your private relay.';
}

function showMfaLogin(challenge) {
  state.mfaLogin = challenge;
  elements.adminApp.classList.add('hidden');
  elements.authView.classList.remove('hidden');
  elements.loginForm.classList.add('hidden');
  elements.bootstrapForm.classList.add('hidden');
  elements.recoveryPanel.classList.add('hidden');
  elements.mfaLoginPanel.classList.remove('hidden');
  elements.mfaRecoveryPanel.classList.toggle('hidden', !challenge.recoveryAvailable);
  elements.authTitle.textContent = 'Security check';
  elements.authLead.textContent = 'Your password was accepted. Complete the optional MFA check.';
}

function showApplication(admin) {
  elements.authView.classList.add('hidden');
  elements.adminApp.classList.remove('hidden');
  elements.adminName.textContent = admin?.displayName || admin?.username || 'Owner';
  elements.adminRole.textContent = admin?.role || 'owner';
  setAuthStatus('');
}

async function login(event) {
  event.preventDefault();
  setAuthStatus('Signing in...');
  try {
    const result = await api('/admin/api/auth/login', {
      method: 'POST',
      body: {
        username: elements.loginUsername.value.trim(),
        password: elements.loginPassword.value,
      },
      publicRequest: true,
    });
    elements.loginPassword.value = '';
    if (result.mfaRequired) {
      showMfaLogin(result);
      await completeMfaLoginWithPasskey();
      return;
    }
    await finishAdminLogin(result);
  } catch (error) {
    setAuthStatus(error.message);
  }
}

async function completeMfaLoginWithPasskey() {
  if (!state.mfaLogin) return;
  if (!browserSupportsPasskeys()) {
    setAuthStatus('This browser does not support passkeys. Use a recovery code instead.');
    return;
  }
  setAuthStatus('Waiting for your passkey...');
  try {
    const credential = await SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: state.mfaLogin.options,
    });
    const result = await api('/admin/api/auth/mfa/passkey', {
      method: 'POST',
      body: { flowToken: state.mfaLogin.flowToken, credential },
      publicRequest: true,
    });
    await finishAdminLogin(result);
  } catch (error) {
    setAuthStatus(error.name === 'NotAllowedError'
      ? 'Passkey prompt closed. Try again or use a recovery code.'
      : error.message);
  }
}

async function completeMfaLoginWithRecoveryCode(event) {
  event.preventDefault();
  if (!state.mfaLogin) return;
  setAuthStatus('Checking recovery code...');
  try {
    const result = await api('/admin/api/auth/mfa/recovery', {
      method: 'POST',
      body: {
        flowToken: state.mfaLogin.flowToken,
        recoveryCode: elements.mfaRecoveryCode.value,
      },
      publicRequest: true,
    });
    elements.mfaRecoveryForm.reset();
    await finishAdminLogin(result);
  } catch (error) {
    setAuthStatus(error.message);
  }
}

function cancelMfaLogin() {
  state.mfaLogin = null;
  elements.mfaRecoveryForm.reset();
  showAuthentication();
  setAuthStatus('');
}

async function finishAdminLogin(result) {
  state.mfaLogin = null;
  state.auth = { ...(state.auth || {}), authenticated: true, admin: result.admin };
  showApplication(result.admin);
  await loadDashboard();
}

async function bootstrapOwner(event) {
  event.preventDefault();
  setAuthStatus('Creating owner...');
  try {
    const result = await api('/admin/api/auth/bootstrap', {
      method: 'POST',
      token: elements.bootstrapToken.value.trim(),
      body: {
        username: elements.bootstrapUsername.value.trim(),
        displayName: elements.bootstrapDisplayName.value.trim(),
        password: elements.bootstrapPassword.value,
      },
      publicRequest: true,
    });
    elements.bootstrapPassword.value = '';
    elements.bootstrapToken.value = '';
    state.auth = { ...(state.auth || {}), bootstrapRequired: false, authenticated: true, admin: result.admin };
    showApplication(result.admin);
    await loadDashboard();
  } catch (error) {
    setAuthStatus(error.message);
  }
}

async function recoverOwner(event) {
  event.preventDefault();
  setAuthStatus('Recovering owner...');
  try {
    const result = await api('/admin/api/auth/recover', {
      method: 'POST',
      token: elements.recoveryToken.value.trim(),
      body: {
        username: elements.recoveryUsername.value.trim(),
        newPassword: elements.recoveryPassword.value,
      },
      publicRequest: true,
    });
    elements.recoveryPassword.value = '';
    elements.recoveryToken.value = '';
    elements.recoveryPanel.open = false;
    state.auth = { ...(state.auth || {}), authenticated: true, admin: result.admin };
    showApplication(result.admin);
    await loadDashboard();
  } catch (error) {
    setAuthStatus(error.message);
  }
}

async function logout() {
  try {
    await api('/admin/api/auth/logout', { method: 'POST', body: {}, publicRequest: true });
  } finally {
    state.auth = { ...(state.auth || {}), authenticated: false, admin: null };
    showAuthentication();
  }
}

async function loadDashboard() {
  elements.refreshButton.disabled = true;
  try {
    const [status, users, devices, pairings, sessions, mfa, audit] = await Promise.all([
      api('/admin/api/status'),
      api('/admin/api/users'),
      api('/admin/api/devices'),
      api('/admin/api/pairings'),
      api('/admin/api/sessions'),
      api('/admin/api/mfa'),
      api('/admin/api/audit'),
    ]);
    state.status = status;
    state.users = users.users || [];
    state.devices = devices.devices || [];
    state.pairings = pairings.pairings || [];
    state.sessions = sessions.sessions || [];
    state.mfa = mfa;
    state.audit = audit.events || [];
    state.auditEnabled = audit.enabled !== false;
    renderAll();
    setRelayStatus('Relay online', 'ok');
  } catch (error) {
    if (error.status === 401) {
      state.auth = { ...(state.auth || {}), authenticated: false, admin: null };
      showAuthentication();
      setAuthStatus('Your admin session expired. Sign in again.');
    } else {
      setRelayStatus('Relay unavailable', 'bad');
      showToast(error.message, true);
    }
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderAll() {
  renderOverview();
  renderUsers();
  renderDevices();
  renderPairings();
  renderSessions();
  renderMfa();
  renderSystem();
  renderAudit();
  renderAccessState();
}

function renderMfa() {
  const supported = browserSupportsPasskeys();
  const enabled = Boolean(state.mfa?.enabled);
  elements.mfaUnsupported.classList.toggle('hidden', supported);
  elements.addPasskeyButton.disabled = !supported;
  elements.regenerateCodesButton.disabled = !enabled;
  elements.disableMfaButton.disabled = !enabled;
  elements.mfaStatusBadge.textContent = enabled ? 'Enabled' : 'Optional';
  elements.mfaStatusBadge.className = `status-badge ${enabled ? 'ok' : 'neutral'}`;

  const passkeys = state.mfa?.passkeys || [];
  if (!passkeys.length) {
    elements.passkeysList.innerHTML = '<p class="empty-inline">No passkeys registered.</p>';
    return;
  }
  elements.passkeysList.innerHTML = passkeys.map((passkey) => `<div class="passkey-row">
    <div><strong>${escapeHtml(passkey.name)}</strong><span>${escapeHtml(passkey.backedUp ? 'Synced passkey' : 'Device passkey')} &middot; Added ${escapeHtml(formatDate(passkey.createdAt))}</span></div>
    <button class="button danger" type="button" data-passkey-id="${escapeAttr(passkey.credentialId)}">Remove</button>
  </div>`).join('');
}

function renderOverview() {
  const onlineDevices = state.devices.filter((device) => device.online).length;
  const activeUsers = state.users.filter((user) => !user.disabledAt).length;
  const stats = [
    ['Users', activeUsers],
    ['Agents online', onlineDevices],
    ['Browser pairings', state.pairings.length],
    ['Admin sessions', state.sessions.length],
  ];
  elements.overviewStats.innerHTML = stats.map(([label, value]) => (
    `<article class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  )).join('');

  elements.overviewDetails.innerHTML = detailRows([
    ['Authentication', state.status.authMode],
    ['Registration', registrationLabel()],
    ['Audit retention', state.status.auditEnabled ? `${state.status.auditRetentionDays} days` : 'Disabled'],
    ['Session metadata', state.status.sessionMetadataEnabled ? 'Stored' : 'Not stored'],
  ]);
}

function renderUsers() {
  const query = elements.userSearch.value.trim().toLowerCase();
  const users = state.users.filter((user) => {
    const text = `${user.userId} ${user.displayName || ''}`.toLowerCase();
    return !query || text.includes(query);
  });
  if (!users.length) return emptyTable(elements.usersBody, 5, query ? 'No matching users.' : 'No users found.');

  elements.usersBody.innerHTML = users.map((user) => {
    const disabled = Boolean(user.disabledAt);
    return `<tr>
      <td><strong>${escapeHtml(user.displayName || user.userId)}</strong><span class="cell-subtitle">${escapeHtml(user.userId)}</span></td>
      <td><span class="pill ${disabled ? 'bad' : 'ok'}">${disabled ? 'Disabled' : 'Active'}</span></td>
      <td>${escapeHtml(`${user.activeTokenCount || 0}/${user.tokenCount || 0}`)}</td>
      <td>${escapeHtml(formatDate(user.createdAt))}</td>
      <td><div class="row-actions">
        <button class="button" data-user-action="rotate" data-user-id="${escapeAttr(user.userId)}">Rotate token</button>
        <button class="button" data-user-action="password-reset" data-user-id="${escapeAttr(user.userId)}">Reset password</button>
        <button class="button" data-user-action="${disabled ? 'enable' : 'disable'}" data-user-id="${escapeAttr(user.userId)}">${disabled ? 'Enable' : 'Disable'}</button>
        <button class="button danger" data-user-action="delete" data-user-id="${escapeAttr(user.userId)}">Delete</button>
      </div></td>
    </tr>`;
  }).join('');
}

function renderDevices() {
  if (!state.devices.length) return emptyTable(elements.devicesBody, 5, 'No agents have connected yet.');
  elements.devicesBody.innerHTML = state.devices.map((device) => `<tr>
    <td>${escapeHtml(device.displayName || device.userId)}<span class="cell-subtitle">${escapeHtml(device.userId)}</span></td>
    <td><strong>${escapeHtml(device.deviceName || device.deviceId)}</strong><span class="cell-subtitle">${escapeHtml(device.deviceId)}</span></td>
    <td><span class="pill ${device.online ? 'ok' : ''}">${device.online ? 'Online' : 'Offline'}</span></td>
    <td>${escapeHtml(device.activePairingCount || 0)}</td>
    <td>${escapeHtml(formatDate(device.lastSeenAt || device.firstSeenAt))}</td>
  </tr>`).join('');
}

function renderPairings() {
  if (!state.pairings.length) return emptyTable(elements.pairingsBody, 5, 'No active browser pairings.');
  elements.pairingsBody.innerHTML = state.pairings.map((pairing) => `<tr>
    <td>${escapeHtml(pairing.userId)}</td>
    <td>${escapeHtml(pairing.deviceName || pairing.deviceId)}<span class="cell-subtitle">${escapeHtml(pairing.deviceId)}</span></td>
    <td>${escapeHtml(pairing.browserLabel || pairing.browserHashPrefix || 'Browser')}</td>
    <td>${escapeHtml(formatDate(pairing.lastUsedAt || pairing.createdAt))}</td>
    <td><button class="button danger" data-pairing-action="revoke" data-pairing-id="${escapeAttr(pairing.pairingId)}">Revoke</button></td>
  </tr>`).join('');
}

function renderSessions() {
  if (!state.sessions.length) return emptyTable(elements.sessionsBody, 5, 'No active admin sessions.');
  elements.sessionsBody.innerHTML = state.sessions.map((session) => `<tr>
    <td><strong>${session.current ? 'Current session' : 'Admin session'}</strong><span class="cell-subtitle">${escapeHtml(shortId(session.sessionId))}</span></td>
    <td>${escapeHtml(formatDate(session.createdAt))}</td>
    <td>${escapeHtml(formatDate(session.lastSeenAt))}</td>
    <td>${escapeHtml(formatDate(session.expiresAt))}</td>
    <td><button class="button danger" data-session-action="revoke" data-session-id="${escapeAttr(session.sessionId)}">${session.current ? 'Sign out' : 'Revoke'}</button></td>
  </tr>`).join('');
  elements.revokeOthersButton.disabled = !state.sessions.some((session) => !session.current);
}

function renderSystem() {
  elements.systemDetails.innerHTML = detailRows([
    ['Auth mode', state.status.authMode],
    ['Database', state.status.database],
    ['SQLite administration', state.status.sqliteAdmin ? 'Enabled' : 'Disabled'],
    ['Registration', registrationLabel()],
    ['Active invite codes', state.status.activeRegistrationInvites || 0],
    ['Audit persistence', state.status.auditEnabled ? 'Enabled' : 'Disabled'],
    ['Session metadata', state.status.sessionMetadataEnabled ? 'Enabled' : 'Disabled'],
  ]);
}

function renderAudit() {
  if (!state.audit.length) {
    return emptyTable(elements.auditBody, 6, state.auditEnabled ? 'No audit events yet.' : 'Audit persistence is disabled.');
  }
  elements.auditBody.innerHTML = state.audit.map((event) => {
    const metadata = event.metadata || {};
    const actor = `${event.actorType || '-'}${event.actorId ? ` / ${event.actorId}` : ''}`;
    const target = event.targetAgentId || metadata.targetUserId || metadata.deviceId || event.targetBrowserPairingId || '-';
    return `<tr>
      <td>${escapeHtml(formatDate(event.createdAt))}</td>
      <td><strong>${escapeHtml(event.eventType)}</strong></td>
      <td>${escapeHtml(event.userId || metadata.targetUserId || '-')}</td>
      <td>${escapeHtml(actor)}</td>
      <td>${escapeHtml(target)}</td>
      <td>${escapeHtml(event.ipAddress || '-')}</td>
    </tr>`;
  }).join('');
}

function renderAccessState() {
  elements.createInviteButton.disabled = !state.status.sqliteAdmin
    || !state.status.registrationEnabled
    || !state.status.registrationRequiresInvite;
  elements.inviteStatus.textContent = registrationLabel();
}

async function createInvite() {
  try {
    const result = await api('/admin/api/registration-invites', { method: 'POST', body: {} });
    revealSecret(`Invitation shown once\n${result.code}\n\nExpires ${formatDate(result.expiresAt)}`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleUserAction(event) {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  const action = button.dataset.userAction;
  const userId = button.dataset.userId;
  const destructive = action === 'delete' || action === 'disable';
  if (destructive && !window.confirm(`${action === 'delete' ? 'Delete' : 'Disable'} ${userId}?`)) return;
  try {
    const result = await api(`/admin/api/users/${encodeURIComponent(userId)}/${action}`, { method: 'POST', body: {} });
    if (result.token) revealSecret(`Agent token shown once for ${userId}\n${result.token}`);
    if (result.code) revealSecret(`Password recovery code shown once for ${userId}\n${result.code}\n\nExpires ${formatDate(result.expiresAt)}`);
    showToast(`${userId}: ${action} completed.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handlePairingAction(event) {
  const button = event.target.closest('[data-pairing-action]');
  if (!button || !window.confirm('Revoke this browser pairing?')) return;
  try {
    await api(`/admin/api/pairings/${encodeURIComponent(button.dataset.pairingId)}/revoke`, { method: 'POST', body: {} });
    showToast('Browser pairing revoked.');
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleSessionAction(event) {
  const button = event.target.closest('[data-session-action]');
  if (!button || !window.confirm('Revoke this admin session?')) return;
  try {
    const current = state.sessions.find((session) => session.sessionId === button.dataset.sessionId)?.current;
    await api(`/admin/api/sessions/${encodeURIComponent(button.dataset.sessionId)}/revoke`, { method: 'POST', body: {} });
    if (current) {
      state.auth = { ...(state.auth || {}), authenticated: false, admin: null };
      showAuthentication();
    } else {
      showToast('Admin session revoked.');
      await loadDashboard();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function revokeOtherSessions() {
  if (!window.confirm('Revoke every other admin session?')) return;
  try {
    const result = await api('/admin/api/sessions/revoke-others', { method: 'POST', body: {} });
    showToast(`${result.count} session${result.count === 1 ? '' : 's'} revoked.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function changePassword(event) {
  event.preventDefault();
  if (elements.newPassword.value !== elements.confirmPassword.value) {
    showToast('The new passwords do not match.', true);
    return;
  }
  try {
    const result = await api('/admin/api/auth/password', {
      method: 'POST',
      body: {
        currentPassword: elements.currentPassword.value,
        newPassword: elements.newPassword.value,
      },
    });
    elements.passwordForm.reset();
    showToast(`Password changed. ${result.revokedSessions || 0} other sessions revoked.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function addPasskey(event) {
  event.preventDefault();
  if (!browserSupportsPasskeys()) {
    showToast('This browser does not support passkeys.', true);
    return;
  }
  try {
    const name = elements.passkeyName.value.trim();
    const currentPassword = elements.mfaCurrentPassword.value;
    const challenge = await api('/admin/api/mfa/passkeys/options', {
      method: 'POST',
      body: { name, currentPassword },
    });
    const credential = await SimpleWebAuthnBrowser.startRegistration({
      optionsJSON: challenge.options,
    });
    const result = await api('/admin/api/mfa/passkeys/complete', {
      method: 'POST',
      body: { flowToken: challenge.flowToken, name, credential },
    });
    elements.passkeyForm.reset();
    state.mfa = result;
    renderMfa();
    if (result.recoveryCodes?.length) revealRecoveryCodes(result.recoveryCodes);
    showToast('Passkey added. MFA is now enabled for this account.');
  } catch (error) {
    showToast(error.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : error.message, true);
  }
}

async function regenerateRecoveryCodes() {
  if (!state.mfa?.enabled) return;
  const currentPassword = elements.mfaCurrentPassword.value;
  if (!currentPassword) {
    showToast('Enter your current password first.', true);
    return;
  }
  if (!window.confirm('Replace every existing recovery code?')) return;
  try {
    const result = await api('/admin/api/mfa/recovery-codes/regenerate', {
      method: 'POST',
      body: { currentPassword },
    });
    elements.mfaCurrentPassword.value = '';
    state.mfa.recoveryCodesRemaining = result.recoveryCodesRemaining;
    revealRecoveryCodes(result.recoveryCodes);
    showToast('New recovery codes generated. Previous codes no longer work.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function disableMfa() {
  if (!state.mfa?.enabled) return;
  const currentPassword = elements.mfaCurrentPassword.value;
  if (!currentPassword) {
    showToast('Enter your current password first.', true);
    return;
  }
  if (!window.confirm('Disable MFA and remove every passkey and recovery code?')) return;
  try {
    await api('/admin/api/mfa/disable', {
      method: 'POST',
      body: { currentPassword },
    });
    elements.mfaCurrentPassword.value = '';
    elements.mfaRecoveryCodes.classList.add('hidden');
    state.mfa = { enabled: false, supported: true, passkeys: [], recoveryCodesRemaining: 0 };
    renderMfa();
    showToast('MFA disabled. Password login remains active.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function removePasskey(event) {
  const button = event.target.closest('[data-passkey-id]');
  if (!button) return;
  const currentPassword = elements.mfaCurrentPassword.value;
  if (!currentPassword) {
    showToast('Enter your current password first.', true);
    return;
  }
  if (!window.confirm('Remove this passkey? Removing the last passkey disables MFA.')) return;
  try {
    const result = await api(`/admin/api/mfa/passkeys/${encodeURIComponent(button.dataset.passkeyId)}/remove`, {
      method: 'POST',
      body: { currentPassword },
    });
    elements.mfaCurrentPassword.value = '';
    state.mfa = result;
    renderMfa();
    showToast(result.enabled ? 'Passkey removed.' : 'Last passkey removed. MFA is disabled.');
  } catch (error) {
    showToast(error.message, true);
  }
}

function revealRecoveryCodes(codes) {
  elements.mfaRecoveryCodes.textContent = [
    'Recovery codes - shown once',
    'Store these somewhere safe. Each code works once.',
    '',
    ...codes,
  ].join('\n');
  elements.mfaRecoveryCodes.classList.remove('hidden');
}

function browserSupportsPasskeys() {
  return Boolean(window.PublicKeyCredential && window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn?.());
}

function selectView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === view));
  const active = document.querySelector(`[data-view="${view}"]`);
  elements.viewTitle.textContent = active?.textContent || 'Administration';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({ ok: false, error: 'Invalid relay response.' }));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code || '';
    throw error;
  }
  return data;
}

function registrationLabel() {
  if (!state.status?.registrationEnabled) return 'Disabled';
  return state.status.registrationRequiresInvite ? 'Invitation required' : 'Open registration';
}

function detailRows(rows) {
  return rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '-')}</dd></div>`).join('');
}

function emptyTable(body, columns, message) {
  body.innerHTML = `<tr><td class="empty-row" colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function revealSecret(text) {
  elements.secretReveal.textContent = text;
  elements.secretReveal.classList.remove('hidden');
  selectView('access');
}

function setRelayStatus(message, kind = 'neutral') {
  elements.relayStatus.textContent = message;
  elements.relayStatus.className = `status-badge ${kind}`;
}

function setAuthStatus(message) {
  elements.authStatus.textContent = message || '';
}

let toastTimer = null;
function showToast(message, bad = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${bad ? ' bad' : ''}`;
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 6000);
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function shortId(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 12)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
