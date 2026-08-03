'use strict';

const relayDb = require('./db');
const credentials = require('./credentials');
const LEGAL = require('./legal');

/**
 * Builds the hosted pilot-account HTTP handler. The relay composition root
 * injects transport, rate-limit, audit, and live-client operations so this
 * module owns account policy without owning WebSocket routing.
 */
function createAccountApi(options = {}) {
  const {
    authMode,
    envAuthMode,
    registrationEnabled,
    registrationRequiresInvite,
    maxAuthAttempts,
    sessions,
    openDatabase,
    generateToken,
    validateRequest,
    sendJson,
    allowAttempt,
    clearAttempts,
    readJsonBody,
    hasRegistrationInvite,
    consumeRegistrationInvite,
    insertAuditEvent,
    reloadRelayUsers,
    closeBrowserSessions,
    closeAgentClients,
  } = options;

  if (!sessions || typeof openDatabase !== 'function') throw new TypeError('account API session storage is required');

  return async function handleAccountApi(req, res, url) {
    const requestCheck = validateRequest(req);
    if (!requestCheck.ok) {
      return sendJson(req, res, requestCheck.status, {
        ok: false,
        code: requestCheck.code,
        error: requestCheck.error,
      });
    }

    if (authMode === envAuthMode) {
      return sendJson(req, res, 409, {
        ok: false,
        code: 'account_mode_unavailable',
        error: 'account login requires sqlite-fallback or sqlite auth mode',
      });
    }

    // Read-only endpoints resolve the current HttpOnly session on every request
    // so disabled users and revoked sessions cannot rely on stale process state.
    if (req.method === 'GET' && url.pathname === '/account/api/status') {
      const session = sessions.getAccountSession(req);
      return sendJson(req, res, 200, {
        ok: true,
        registrationEnabled,
        registrationRequiresInvite: registrationEnabled && registrationRequiresInvite,
        legal: LEGAL,
        authenticated: Boolean(session),
        user: session ? publicAccountUser(session) : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/account/api/me') {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);
      return sendJson(req, res, 200, { ok: true, user: publicAccountUser(session) });
    }

    if (req.method === 'GET' && url.pathname === '/account/api/sessions') {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);
      return withDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        sessions: relayDb.listBrowserSessions(db, session.userId).map((item) => ({
          ...item,
          current: item.sessionId === session.sessionId,
        })),
      }));
    }

    const sessionAction = url.pathname.match(/^\/account\/api\/sessions\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && sessionAction) {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);
      const sessionId = decodeURIComponent(sessionAction[1]);
      return withDatabase((db) => {
        const result = relayDb.revokeBrowserSessionById(db, session.userId, sessionId);
        if (!result.count) {
          return sendJson(req, res, 404, { ok: false, code: 'session_not_found', error: 'session not found' });
        }
        insertAuditEvent(db, req, {
          eventType: 'account.session_revoked',
          userId: session.userId,
          metadata: { sessionId, current: sessionId === session.sessionId },
        });
        closeBrowserSessions(session.userId, [sessionId], 'browser session revoked');
        const headers = sessionId === session.sessionId ? sessions.clearAccountCookieHeaders(req) : {};
        return sendJson(req, res, 200, {
          ok: true,
          count: result.count,
          current: sessionId === session.sessionId,
        }, headers);
      });
    }

    if (req.method === 'POST' && url.pathname === '/account/api/sessions/revoke-others') {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);
      return withDatabase((db) => {
        const result = relayDb.revokeOtherBrowserSessions(db, session.userId, session.sessionId);
        insertAuditEvent(db, req, {
          eventType: 'account.sessions_revoked_others',
          userId: session.userId,
          metadata: { count: result.count },
        });
        closeBrowserSessions(session.userId, result.sessionIds, 'browser session revoked');
        return sendJson(req, res, 200, { ok: true, count: result.count });
      });
    }

    // Registration and credential endpoints share the relay's origin, JSON,
    // and rate-limit guards before this handler touches password material.
    if (req.method === 'POST' && url.pathname === '/account/api/register') {
      if (!allowAttempt(req, res, 'registration', maxAuthAttempts)) return;
      if (!registrationEnabled) {
        return sendJson(req, res, 403, {
          ok: false,
          code: 'registration_disabled',
          error: 'registration is disabled',
        });
      }

      const body = await readJsonBody(req);
      if (registrationRequiresInvite && !hasRegistrationInvite(body.inviteCode)) {
        return sendJson(req, res, 403, {
          ok: false,
          code: 'invalid_invite',
          error: 'a valid registration invite is required',
        });
      }
      if (!hasCurrentLegalAcceptance(body)) {
        return sendJson(req, res, 400, {
          ok: false,
          code: 'legal_acceptance_required',
          error: 'the current terms and privacy notice must be accepted',
          legal: LEGAL,
        });
      }
      const userId = credentials.requireAccountUserId(body.userId);
      const displayName = credentials.requireAccountDisplayName(body.displayName || userId);
      const password = credentials.requireAccountPassword(body.password);
      const agentToken = generateToken();
      const passwordHash = credentials.hashPassword(password);

      return withDatabase((db) => {
        if (relayDb.getRelayUser(db, userId)) {
          return sendJson(req, res, 409, {
            ok: false,
            code: 'username_taken',
            error: 'username already exists',
          });
        }

        const account = relayDb.createRelayAccount(db, {
          userId,
          displayName,
          passwordHash,
          token: agentToken,
          tokenName: 'VoxHF agent token',
          termsVersion: LEGAL.termsVersion,
          privacyVersion: LEGAL.privacyVersion,
          legalAcceptanceMethod: 'registration',
        });
        if (registrationRequiresInvite) consumeRegistrationInvite(body.inviteCode);
        const session = sessions.createAccountSession(db, req, userId);
        insertAuditEvent(db, req, {
          eventType: 'account.registered',
          userId,
          metadata: { tokenPrefix: account.tokenPrefix },
        });
        reloadRelayUsers();
        clearAttempts(req, 'registration');
        return sendJson(req, res, 201, {
          ok: true,
          user: publicAccountUser(session),
          agentToken,
          tokenPrefix: account.tokenPrefix,
        }, sessions.accountCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/account/api/login') {
      if (!allowAttempt(req, res, 'login', maxAuthAttempts)) return;
      const body = await readJsonBody(req);
      const userId = String(body.userId || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!credentials.isUserId(userId) || password.length < 1 || password.length > 256) {
        return invalidCredentials(req, res);
      }

      return withDatabase((db) => {
        const user = relayDb.getRelayUserCredentials(db, userId);
        if (!user || user.disabledAt || !user.passwordHash
            || !credentials.verifyPassword(password, user.passwordHash)) {
          return invalidCredentials(req, res);
        }

        const session = sessions.createAccountSession(db, req, user.userId);
        insertAuditEvent(db, req, { eventType: 'account.login', userId: user.userId });
        clearAttempts(req, 'login');
        return sendJson(req, res, 200, {
          ok: true,
          user: publicAccountUser(session),
        }, sessions.accountCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/account/api/password/change') {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);
      if (!allowAttempt(req, res, 'password-change', maxAuthAttempts)) return;
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPasswordHash = credentials.hashPassword(credentials.requireAccountPassword(body.newPassword));
      return withDatabase((db) => {
        const account = relayDb.getRelayUserCredentials(db, session.userId);
        if (!account?.passwordHash || !credentials.verifyPassword(currentPassword, account.passwordHash)) {
          return sendJson(req, res, 401, {
            ok: false,
            code: 'invalid_credentials',
            error: 'invalid current password',
          });
        }
        relayDb.setRelayUserPassword(db, session.userId, newPasswordHash);
        const revoked = relayDb.revokeOtherBrowserSessions(db, session.userId, session.sessionId);
        insertAuditEvent(db, req, {
          eventType: 'account.password_changed',
          userId: session.userId,
          metadata: { revokedSessions: revoked.count },
        });
        closeBrowserSessions(session.userId, revoked.sessionIds, 'password changed');
        clearAttempts(req, 'password-change');
        return sendJson(req, res, 200, { ok: true, revokedSessions: revoked.count });
      });
    }

    if (req.method === 'POST' && url.pathname === '/account/api/password/recover') {
      if (!allowAttempt(req, res, 'password-recovery', maxAuthAttempts)) return;
      const body = await readJsonBody(req);
      const userId = credentials.requireAccountUserId(body.userId);
      const recoveryCode = credentials.normalizeAccountRecoveryCode(body.recoveryCode);
      const newPasswordHash = credentials.hashPassword(credentials.requireAccountPassword(body.newPassword));
      return withDatabase((db) => {
        const account = relayDb.getRelayUserCredentials(db, userId);
        const invalid = () => sendJson(req, res, 401, {
          ok: false,
          code: 'invalid_recovery_code',
          error: 'invalid or expired recovery code',
        });
        if (!account || account.disabledAt || !recoveryCode) return invalid();
        const consumed = relayDb.consumeAccountRecoveryCode(db, {
          userId,
          codeHash: relayDb.hashToken(recoveryCode),
        });
        if (!consumed.count) return invalid();

        relayDb.setRelayUserPassword(db, userId, newPasswordHash);
        const revoked = relayDb.revokeAllBrowserSessions(db, userId);
        closeBrowserSessions(userId, revoked.sessionIds, 'account recovered');
        const session = sessions.createAccountSession(db, req, userId);
        insertAuditEvent(db, req, {
          eventType: 'account.password_recovered',
          userId,
          metadata: { revokedSessions: revoked.count },
        });
        clearAttempts(req, 'password-recovery');
        return sendJson(req, res, 200, {
          ok: true,
          user: publicAccountUser(session),
        }, sessions.accountCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/account/api/logout') {
      const token = sessions.getAccountToken(req);
      const session = sessions.getAccountSession(req);
      if (token) withDatabase((db) => relayDb.revokeBrowserSession(db, token));
      if (session) closeBrowserSessions(session.userId, [session.sessionId], 'account logged out');
      return sendJson(req, res, 200, { ok: true }, sessions.clearAccountCookieHeaders(req));
    }

    if (req.method === 'POST' && url.pathname === '/account/api/agent-token/rotate') {
      const session = sessions.getAccountSession(req);
      if (!session) return notAuthenticated(req, res);

      return withDatabase((db) => {
        const agentToken = generateToken();
        const result = relayDb.importRelayUserToken(db, {
          userId: session.userId,
          displayName: session.userName || session.userId,
          token: agentToken,
          tokenName: 'VoxHF agent token',
        });
        insertAuditEvent(db, req, {
          eventType: 'account.agent_token_rotated',
          userId: session.userId,
          metadata: { tokenPrefix: result.tokenPrefix },
        });
        reloadRelayUsers();
        closeAgentClients(session.userId, 'relay token rotated');
        return sendJson(req, res, 200, {
          ok: true,
          agentToken,
          tokenPrefix: result.tokenPrefix,
        });
      });
    }

    return sendJson(req, res, 404, { ok: false, error: 'not found' });
  };

  function withDatabase(callback) {
    // API operations are intentionally short SQLite transactions. Keeping the
    // handle request-scoped prevents an extracted module from owning DB lifetime.
    const db = openDatabase();
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  function notAuthenticated(req, res) {
    return sendJson(req, res, 401, {
      ok: false,
      code: 'not_authenticated',
      error: 'not authenticated',
    });
  }

  function invalidCredentials(req, res) {
    return sendJson(req, res, 401, {
      ok: false,
      code: 'invalid_credentials',
      error: 'invalid username or password',
    });
  }
}

function publicAccountUser(session) {
  return {
    userId: session.userId,
    userName: session.userName || session.displayName || session.userId,
    expiresAt: session.expiresAt,
  };
}

function hasCurrentLegalAcceptance(body) {
  return body.acceptTerms === true
    && body.acknowledgePrivacy === true
    && body.termsVersion === LEGAL.termsVersion
    && body.privacyVersion === LEGAL.privacyVersion;
}

module.exports = { createAccountApi };
