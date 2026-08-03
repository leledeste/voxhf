'use strict';

// Account and browser-session behavior for the operational workspace. The
// controller receives the small pieces of app orchestration it needs, keeping
// relay, radio, chat, notification, and audio state in app.js.
(function exposeAccountModule(root) {
  const ACCOUNT_STORAGE_KEY = 'voxhf.accountSettings.v1';

  function loadStoredAccount(storage = root.localStorage) {
    try {
      const saved = JSON.parse(storage.getItem(ACCOUNT_STORAGE_KEY) || '{}');
      return {
        userId: String(saved.userId || ''),
        userName: String(saved.userName || ''),
      };
    } catch (_) {
      return { userId: '', userName: '' };
    }
  }

  function saveStoredAccount(storage, account) {
    storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({
      userId: String(account.userId || ''),
      userName: String(account.userName || ''),
    }));
  }

  function accountErrorMessage(error) {
    switch (error?.code) {
      case 'account_mode_unavailable':
        return 'Hosted accounts are not enabled on this relay. Use Manual Relay Setup.';
      case 'invalid_password':
        return 'Password must be 10-256 characters.';
      case 'invalid_credentials':
        return 'The current password is incorrect.';
      case 'auth_rate_limited':
        return 'Too many attempts. Wait a few seconds and try again.';
      case 'not_authenticated':
        return 'Your session expired. Log in again.';
      default:
        return error?.message || 'Account request failed.';
    }
  }

  function createAccountController(options = {}) {
    const state = options.state;
    if (!state?.account || !state?.remote) {
      throw new Error('Account controller requires workspace account and remote state.');
    }

    const storage = options.storage || root.localStorage;
    const document = options.document || root.document;
    const location = options.location || root.location;
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const getElement = options.getElement || (id => document.getElementById(id));
    const getRelay = options.getRelay || (() => state.remote.relay || '');
    const getAccountLabel = options.getAccountLabel || (() => state.account.userName || state.account.userId || 'Logged in');
    const updateWorkspace = options.updateWorkspace || (() => {});
    const setRemoteCheck = options.setRemoteCheck || (() => {});
    const addLocal = options.addLocal || (() => {});
    const addErrorMessage = options.addErrorMessage || (() => {});
    const saveManualPreference = options.saveManualPreference || (() => {});
    const connect = options.connect || (() => {});
    const closeSettings = options.closeSettings || (() => {});
    const confirmAction = options.confirmAction || root.confirm?.bind(root) || (() => false);

    function buildApiUrl(pathname) {
      const relay = String(getRelay() || '').trim();
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

    async function request(pathname, requestOptions = {}) {
      const url = buildApiUrl(pathname);
      if (!url) throw new Error('Remote relay URL is required.');
      if (!fetchImpl) throw new Error('Account requests are unavailable in this browser.');
      const response = await fetchImpl(url, {
        method: requestOptions.method || 'GET',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
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

    function saveAccount() {
      saveStoredAccount(storage, state.account);
    }

    function shouldShowGate() {
      // Hosted accounts are the normal remote entry path. A manual token is
      // still accepted after the user deliberately dismisses this gate.
      return state.remote.enabled
        && !state.account.authenticated
        && !state.remote.token
        && !state.authOverlayDismissed;
    }

    function openPage() {
      const next = `${location.pathname}${location.search}${location.hash}`;
      const loginPage = location.protocol === 'https:' ? '/login' : 'login.html';
      location.replace(`${loginPage}?next=${encodeURIComponent(next)}`);
    }

    function showGate(message = '') {
      getElement('auth-copy').textContent = message
        || 'Sign in with your hosted account, or configure a private relay manually.';
      getElement('overlay').classList.add('hidden');
      getElement('auth-overlay').classList.remove('hidden');
    }

    function hideGate() {
      getElement('auth-overlay').classList.add('hidden');
    }

    function updateGate() {
      if (shouldShowGate()) showGate();
      else hideGate();
    }

    function openLogin() {
      state.authOverlayDismissed = false;
      saveManualPreference(false);
      closeSettings();
      openPage();
    }

    function setSecurityStatus(message, tone = '') {
      const output = getElement('settings-account-security-status');
      output.textContent = message || '';
      output.className = `auth-status${tone ? ` ${tone}` : ''}`;
    }

    function showAgentToken(token) {
      const text = `Agent token shown once:\n${token}\n\nPut it in config.json as remoteRelayToken, then restart VoxHF on the Altitude PC.`;
      const box = getElement('settings-account-token');
      box.textContent = text;
      box.classList.remove('hidden');
    }

    function hideAgentToken() {
      const box = getElement('settings-account-token');
      box.textContent = '';
      box.classList.add('hidden');
    }

    function renderSessions() {
      const list = getElement('settings-account-sessions');
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

    function renderSettings() {
      getElement('settings-account-state').textContent = state.account.authenticated
        ? `Logged in as ${getAccountLabel()}`
        : 'Not logged in';
      getElement('settings-account-username').value = state.account.userId || '';
      getElement('settings-account-open').disabled = state.account.authenticated;
      getElement('settings-account-logout').disabled = !state.account.authenticated;
      getElement('settings-account-rotate-token').disabled = !state.account.authenticated;
      getElement('settings-account-security').classList.toggle('hidden', !state.account.authenticated);
      getElement('settings-remote-pair').disabled = state.account.authenticated;
      renderSessions();
    }

    async function refreshSessions(showStatus = true) {
      if (!state.account.authenticated) {
        state.account.sessions = [];
        renderSessions();
        return;
      }
      try {
        const result = await request('/account/api/sessions');
        state.account.sessions = result.sessions || [];
        renderSessions();
        if (showStatus) setSecurityStatus('Sessions refreshed.', 'good');
      } catch (error) {
        if (showStatus) setSecurityStatus(accountErrorMessage(error), 'bad');
      }
    }

    async function refreshStatus() {
      if (!state.remote.enabled && !state.remote.relay) return false;
      try {
        const body = await request('/account/api/status');
        state.account.authenticated = Boolean(body.authenticated && body.user);
        state.account.userId = body.user?.userId || state.account.userId || '';
        state.account.userName = body.user?.userName || body.user?.userId || state.account.userName || '';
        saveAccount();
        if (state.account.authenticated) await refreshSessions(false);
        else state.account.sessions = [];
        updateWorkspace();
        updateGate();
        return true;
      } catch (_) {
        // A failed status request leaves the workspace usable while normal
        // relay reconnect handling explains the network problem.
        state.account.authenticated = false;
        updateWorkspace();
        updateGate();
        return false;
      }
    }

    async function logout() {
      try {
        await request('/account/api/logout', { method: 'POST' });
      } catch (_) {}
      state.account.authenticated = false;
      state.account.userId = '';
      state.account.userName = '';
      state.account.sessions = [];
      saveAccount();
      renderSessions();
      hideAgentToken();
      setRemoteCheck('Account logged out');
      state.authOverlayDismissed = false;
      saveManualPreference(false);
      if (state.remote.enabled && location.protocol === 'https:') {
        openPage();
        return;
      }
      updateGate();
      connect(true);
    }

    async function rotateAgentToken() {
      try {
        const result = await request('/account/api/agent-token/rotate', { method: 'POST' });
        showAgentToken(result.agentToken);
        setRemoteCheck('Agent token rotated');
        addLocal('Agent token rotated. Update config.json and restart VoxHF on the Altitude PC.');
      } catch (error) {
        addErrorMessage(`Agent token rotation failed: ${accountErrorMessage(error)}`);
      }
    }

    async function revokeSession(sessionId) {
      try {
        await request(`/account/api/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' });
        setSecurityStatus('Session revoked.', 'good');
        await refreshSessions(false);
      } catch (error) {
        setSecurityStatus(accountErrorMessage(error), 'bad');
      }
    }

    async function revokeOtherSessions() {
      if (!state.account.authenticated || !confirmAction('Log out every other browser session?')) return;
      try {
        const result = await request('/account/api/sessions/revoke-others', { method: 'POST' });
        setSecurityStatus(`${result.count} other session${result.count === 1 ? '' : 's'} logged out.`, 'good');
        await refreshSessions(false);
      } catch (error) {
        setSecurityStatus(accountErrorMessage(error), 'bad');
      }
    }

    async function changePassword(event) {
      event.preventDefault();
      const currentPassword = getElement('settings-account-current-password').value;
      const newPassword = getElement('settings-account-new-password').value;
      const confirmation = getElement('settings-account-confirm-password').value;
      if (newPassword.length < 10) {
        setSecurityStatus('New password must be at least 10 characters.', 'bad');
        return;
      }
      if (newPassword !== confirmation) {
        setSecurityStatus('The new passwords do not match.', 'bad');
        return;
      }
      try {
        const result = await request('/account/api/password/change', {
          method: 'POST',
          body: { currentPassword, newPassword },
        });
        getElement('settings-account-password-form').reset();
        setSecurityStatus(`Password changed. ${result.revokedSessions || 0} other session${result.revokedSessions === 1 ? '' : 's'} logged out.`, 'good');
        await refreshSessions(false);
      } catch (error) {
        setSecurityStatus(accountErrorMessage(error), 'bad');
      }
    }

    function bindUi() {
      getElement('settings-account-open').onclick = openLogin;
      getElement('settings-account-logout').onclick = logout;
      getElement('settings-account-rotate-token').onclick = rotateAgentToken;
      getElement('settings-account-refresh-sessions').onclick = () => refreshSessions(true);
      getElement('settings-account-revoke-others').onclick = revokeOtherSessions;
      getElement('settings-account-sessions').onclick = event => {
        const button = event.target.closest('[data-account-session-id]');
        if (button) revokeSession(button.dataset.accountSessionId);
      };
      getElement('settings-account-password-form').onsubmit = changePassword;
      getElement('auth-login').onclick = openLogin;
    }

    return Object.freeze({
      accountErrorMessage,
      bindUi,
      buildApiUrl,
      changePassword,
      hideGate,
      logout,
      openLogin,
      openPage,
      refreshSessions,
      refreshStatus,
      renderSessions,
      renderSettings,
      request,
      revokeOtherSessions,
      revokeSession,
      rotateAgentToken,
      shouldShowGate,
      showGate,
      updateGate,
    });
  }

  const accountModule = Object.freeze({
    ACCOUNT_STORAGE_KEY,
    accountErrorMessage,
    createAccountController,
    loadStoredAccount,
    saveStoredAccount,
  });

  if (typeof window !== 'undefined') window.VoxHFAccount = accountModule;
  if (typeof module !== 'undefined' && module.exports) module.exports = accountModule;
})(typeof window !== 'undefined' ? window : globalThis);
