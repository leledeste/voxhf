'use strict';

const crypto = require('crypto');
const adminMfa = require('./admin-mfa');
const relayDb = require('./db');
const {
  isUserId,
  requireAccountDisplayName,
  requireAccountPassword,
  hashPassword,
  verifyPassword,
  normalizeAccountRecoveryCode,
} = require('./credentials');

/**
 * Builds the relay-owner administration API. Account/device operations, owner
 * authentication, and MFA live here; live WebSocket routing remains in the
 * relay composition root and is reached only through injected callbacks.
 */
function createAdminApi(options = {}) {
  const {
    config,
    sessions,
    relayUsers,
    registrationInvites,
    openDatabase,
    generateRelayToken,
    validateApiRequest,
    sendJson,
    allowHttpAttempt,
    clearHttpAttempts,
    readJsonBody,
    authorizeAdminTokenRequest,
    createRegistrationInvite,
    purgeExpiredRegistrationInvites,
    listAdminRelayDevices,
    listAdminRelayPairings,
    revokeBrowserAuthorizationByHash,
    disconnectRevokedPairingClients,
    reloadRelayUsers,
    closeClientsForUser,
  } = options;
  const {
    authMode: RELAY_AUTH_MODE,
    envAuthMode: AUTH_MODE_ENV,
    registrationEnabled: ENABLE_ACCOUNT_REGISTRATION,
    registrationRequiresInvite: REQUIRE_REGISTRATION_INVITE,
    persistAudit: PERSIST_AUDIT,
    auditRetentionDays: AUDIT_RETENTION_DAYS,
    storeSessionMetadata: STORE_SESSION_METADATA,
    maxAdminAttempts: MAX_ADMIN_ATTEMPTS_PER_WINDOW,
    accountRecoveryTtlMs: ACCOUNT_RECOVERY_TTL_MS,
    adminTokenHash: ADMIN_TOKEN_HASH,
    allowedOrigins: ALLOWED_ORIGINS,
    webauthnRpId: WEBAUTHN_RP_ID,
    webauthnRpName: WEBAUTHN_RP_NAME,
    mfaChallengeTtlMs: ADMIN_MFA_CHALLENGE_TTL_MS,
  } = config;
  const {
    createAdminSession: createAdminLoginSession,
    getAdminSession: getAdminSessionFromRequest,
    getAdminToken: getAdminSessionTokenFromRequest,
    adminCookieHeaders: adminSessionCookieHeaders,
    clearAdminCookieHeaders: clearAdminSessionCookieHeaders,
  } = sessions;

  async function handleAdminApi(req, res, url) {
    // Apply the shared origin and JSON-content policy before either bootstrap
    // token authentication or an owner session is evaluated.
    const requestCheck = validateApiRequest(req);
    if (!requestCheck.ok) {
      return sendJson(req, res, requestCheck.status, {
        ok: false,
        code: requestCheck.code,
        error: requestCheck.error,
      });
    }

    if (url.pathname.startsWith('/admin/api/auth/')) {
      return handleAdminAuthApi(req, res, url);
    }

    const admin = authorizeAdminRequest(req);
    if (!admin.ok) {
      if (!allowHttpAttempt(req, res, 'admin', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      return sendJson(req, res, admin.status, { ok: false, error: admin.error });
    }
    clearHttpAttempts(req, 'admin');
    req.voxhfAdmin = admin;

    if (req.method === 'GET' && url.pathname === '/admin/api/status') {
      purgeExpiredRegistrationInvites();
      return sendJson(req, res, 200, {
        ok: true,
        authMode: RELAY_AUTH_MODE,
        sqliteAdmin: RELAY_AUTH_MODE !== AUTH_MODE_ENV,
        users: relayUsers.size,
        database: defaultRelayDatabasePath(),
        registrationEnabled: ENABLE_ACCOUNT_REGISTRATION,
        registrationRequiresInvite: REQUIRE_REGISTRATION_INVITE,
        activeRegistrationInvites: registrationInvites.size,
        auditEnabled: PERSIST_AUDIT,
        auditRetentionDays: AUDIT_RETENTION_DAYS,
        sessionMetadataEnabled: STORE_SESSION_METADATA,
        adminSession: admin.kind === 'session',
        admin: admin.kind === 'session' ? publicAdminAccount(admin) : null,
      });
    }

    if (RELAY_AUTH_MODE === AUTH_MODE_ENV) {
      return sendJson(req, res, 409, {
        ok: false,
        error: 'sqlite admin is disabled while VOXHF_RELAY_AUTH_MODE=env',
      });
    }

    // MFA management is deliberately unavailable to the break-glass token; i
    // requires a normal owner session and rechecks the password where needed.
    if (url.pathname === '/admin/api/mfa' || url.pathname.startsWith('/admin/api/mfa/')) {
      if (admin.kind !== 'session') {
        return sendJson(req, res, 403, {
          ok: false,
          code: 'admin_session_required',
          error: 'login with an admin account to manage MFA',
        });
      }
      return handleAdminMfaApi(req, res, url, admin);
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/registration-invites') {
      if (!ENABLE_ACCOUNT_REGISTRATION || !REQUIRE_REGISTRATION_INVITE) {
        return sendJson(req, res, 409, {
          ok: false,
          error: 'invite-only registration is not enabled',
        });
      }
      const invite = createRegistrationInvite();
      withAdminDatabase((db) => insertAdminAuditEvent(db, req, {
        eventType: 'registration.invite_created',
        metadata: { expiresAt: invite.expiresAt },
      }));
      return sendJson(req, res, 201, { ok: true, ...invite });
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/sessions') {
      if (admin.kind !== 'session') {
        return sendJson(req, res, 403, {
          ok: false,
          code: 'admin_session_required',
          error: 'login with an admin account to manage sessions',
        });
      }
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        sessions: relayDb.listAdminSessions(db, admin.adminId).map((session) => ({
          ...session,
          current: session.sessionId === admin.sessionId,
        })),
      }));
    }

    const adminSessionAction = url.pathname.match(/^\/admin\/api\/sessions\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && adminSessionAction) {
      if (admin.kind !== 'session') {
        return sendJson(req, res, 403, { ok: false, code: 'admin_session_required', error: 'admin session required' });
      }
      const sessionId = decodeURIComponent(adminSessionAction[1]);
      return withAdminDatabase((db) => {
        const result = relayDb.revokeAdminSessionById(db, admin.adminId, sessionId);
        if (!result.count) return sendJson(req, res, 404, { ok: false, error: 'session not found' });
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.session_revoked',
          metadata: { sessionId, current: sessionId === admin.sessionId },
        });
        const headers = sessionId === admin.sessionId ? clearAdminSessionCookieHeaders(req) : {};
        return sendJson(req, res, 200, { ok: true, count: result.count }, headers);
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/sessions/revoke-others') {
      if (admin.kind !== 'session') {
        return sendJson(req, res, 403, { ok: false, code: 'admin_session_required', error: 'admin session required' });
      }
      return withAdminDatabase((db) => {
        const result = relayDb.revokeOtherAdminSessions(db, admin.adminId, admin.sessionId);
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.sessions_revoked_others',
          metadata: { count: result.count },
        });
        return sendJson(req, res, 200, { ok: true, count: result.count });
      });
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/users') {
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        users: listAdminRelayUsers(db),
      }));
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/devices') {
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        devices: listAdminRelayDevices(db),
      }));
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/pairings') {
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        pairings: listAdminRelayPairings(db),
      }));
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/audit') {
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        enabled: PERSIST_AUDIT,
        events: PERSIST_AUDIT ? listAdminAuditEvents(db) : [],
      }));
    }

    const pairingAction = url.pathname.match(/^\/admin\/api\/pairings\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && pairingAction) {
      const pairingId = decodeURIComponent(pairingAction[1]);
      return withAdminDatabase((db) => {
        const result = revokeAdminRelayPairing(db, pairingId);
        if (!result) return sendJson(req, res, 404, { ok: false, error: 'pairing not found' });
        insertAdminAuditEvent(db, req, {
          eventType: 'pairing.revoked_admin',
          userId: result.userId,
          targetAgentId: result.deviceId,
          targetBrowserPairingId: result.pairingId,
          metadata: { deviceId: result.deviceId },
        });
        revokeBrowserAuthorizationByHash(result.userId, result.browserIdHash, result.deviceId);
        disconnectRevokedPairingClients(result.userId, result.browserIdHash, result.deviceId);
        return sendJson(req, res, 200, { ok: true, action: 'revoked', count: result.count });
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/users') {
      const body = await readJsonBody(req);
      const userId = requireAdminUserId(body.userId);
      return withAdminDatabase((db) => {
        const existing = getAdminRelayUser(db, userId);
        if (existing) return sendJson(req, res, 409, { ok: false, error: 'user already exists' });

        const token = generateRelayToken();
        const result = importAdminRelayUserToken(db, {
          userId,
          displayName: String(body.displayName || userId).trim() || userId,
          token,
        });
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.user_created',
          userId,
          metadata: { targetUserId: userId },
        });
        reloadRelayUsers();
        sendJson(req, res, 201, { ok: true, action: result.action, userId, token });
      });
    }

    const userAction = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/(rotate|revoke|password-reset|disable|enable|delete)$/);
    if (req.method === 'POST' && userAction) {
      const userId = requireAdminUserId(decodeURIComponent(userAction[1]));
      const action = userAction[2];
      return withAdminDatabase((db) => {
        const existing = getAdminRelayUser(db, userId);
        if (!existing) return sendJson(req, res, 404, { ok: false, error: 'user not found' });

        if (action === 'rotate') {
          const token = generateRelayToken();
          const result = importAdminRelayUserToken(db, {
            userId,
            displayName: existing.displayName || userId,
            token,
          });
          insertAdminAuditEvent(db, req, {
            eventType: 'admin.token_rotated',
            userId,
            metadata: { targetUserId: userId },
          });
          reloadRelayUsers();
          closeClientsForUser(userId, 'relay token rotated');
          return sendJson(req, res, 200, { ok: true, action: result.action, userId, token });
        }

        if (action === 'revoke') {
          const result = revokeAdminRelayUserTokens(db, { userId });
          insertAdminAuditEvent(db, req, {
            eventType: 'admin.tokens_revoked',
            userId,
            metadata: { targetUserId: userId, count: result.count },
          });
          reloadRelayUsers();
          closeClientsForUser(userId, 'relay token revoked');
          return sendJson(req, res, 200, { ok: true, action: result.action, userId, count: result.count });
        }

        if (action === 'password-reset') {
          const code = generateAccountRecoveryCode();
          const expiresAt = new Date(Date.now() + ACCOUNT_RECOVERY_TTL_MS).toISOString();
          relayDb.createAccountRecoveryCode(db, {
            userId,
            codeHash: relayDb.hashToken(normalizeAccountRecoveryCode(code)),
            expiresAt,
          });
          insertAdminAuditEvent(db, req, {
            eventType: 'admin.password_recovery_created',
            userId,
            metadata: { targetUserId: userId, expiresAt },
          });
          return sendJson(req, res, 201, { ok: true, action, userId, code, expiresAt });
        }

        if (action === 'disable' || action === 'enable') {
          const disabled = action === 'disable';
          const result = setAdminRelayUserDisabled(db, userId, disabled);
          insertAdminAuditEvent(db, req, {
            eventType: disabled ? 'admin.user_disabled' : 'admin.user_enabled',
            userId,
            metadata: { targetUserId: userId },
          });
          reloadRelayUsers();
          if (disabled) closeClientsForUser(userId, 'relay user disabled');
          return sendJson(req, res, 200, { ok: true, action: result.action, userId });
        }

        if (action === 'delete') {
          const pairings = relayDb.listActiveBrowserPairings(db)
            .filter((pairing) => pairing.userId === userId);
          insertAdminAuditEvent(db, req, {
            eventType: 'admin.user_deleted',
            userId,
            metadata: { targetUserId: userId, activePairingCount: pairings.length },
          });
          const result = deleteAdminRelayUser(db, userId);
          reloadRelayUsers();
          for (const pairing of pairings) {
            revokeBrowserAuthorizationByHash(pairing.userId, pairing.browserIdHash, pairing.deviceId);
          }
          closeClientsForUser(userId, 'relay user deleted');
          return sendJson(req, res, 200, { ok: true, action: result.action, userId, count: result.count });
        }

        return sendJson(req, res, 400, { ok: false, error: 'unknown action' });
      });
    }

    return sendJson(req, res, 404, { ok: false, error: 'not found' });
  }

  async function handleAdminMfaApi(req, res, url, admin) {
    // WebAuthn challenges are purpose-bound, session-bound where applicable,
    // short-lived, and consumed by the database layer before verification.
    const dbApi = relayDb;

    if (req.method === 'GET' && url.pathname === '/admin/api/mfa') {
      return withAdminDatabase((db) => sendJson(req, res, 200, {
        ok: true,
        enabled: dbApi.listAdminPasskeys(db, admin.adminId).length > 0,
        supported: true,
        passkeys: publicAdminPasskeys(dbApi.listAdminPasskeys(db, admin.adminId)),
        recoveryCodesRemaining: dbApi.countAdminRecoveryCodes(db, admin.adminId),
      }));
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/mfa/passkeys/options') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-manage', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);

      const name = requirePasskeyName(body.name);

      return withAdminDatabaseAsync(async (db) => {
        requireCurrentAdminPassword(db, admin, body.currentPassword);
        const account = dbApi.getAdminAccountCredentialsById(db, admin.adminId);
        const passkeys = dbApi.listAdminPasskeys(db, admin.adminId);
        let context;
        try {
          context = adminMfa.resolveWebAuthnContext(req, {
            allowedOrigins: ALLOWED_ORIGINS,
            rpId: WEBAUTHN_RP_ID,
            rpName: WEBAUTHN_RP_NAME,
          });
        } catch (err) {
          throw apiError(400, 'webauthn_configuration_error', err.message);
        }

        const options = await adminMfa.createRegistrationOptions(account, passkeys, context);
        const flowToken = generateRelayToken();
        const expiresAt = new Date(Date.now() + ADMIN_MFA_CHALLENGE_TTL_MS).toISOString();
        dbApi.createAdminMfaChallenge(db, {
          adminId: admin.adminId,
          flowToken,
          purpose: 'registration',
          challenge: options.challenge,
          origin: context.origin,
          rpId: context.rpId,
          sessionId: admin.sessionId,
          expiresAt,
        });
        clearHttpAttempts(req, 'admin-mfa-manage');
        return sendJson(req, res, 200, { ok: true, flowToken, expiresAt, name, options });
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/mfa/passkeys/complete') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-manage', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const flowToken = String(body.flowToken || '').trim();
      const name = requirePasskeyName(body.name);
      const credential = body.credential;
      if (!isTokenLike(flowToken) || !credential?.id) {
        throw apiError(400, 'invalid_mfa_response', 'passkey response is incomplete');
      }

      return withAdminDatabaseAsync(async (db) => {
        const challenge = dbApi.consumeAdminMfaChallenge(db, {
          flowToken,
          purpose: 'registration',
          adminId: admin.adminId,
          sessionId: admin.sessionId,
        });
        if (!challenge) throw apiError(401, 'mfa_challenge_expired', 'Passkey challenge expired; try again');
        if (dbApi.getAdminPasskey(db, admin.adminId, credential.id)) {
          throw apiError(409, 'passkey_exists', 'this passkey is already registered');
        }

        let registrationInfo;
        try {
          registrationInfo = await adminMfa.completeRegistration(
            credential,
            challenge.challenge,
            { origin: challenge.origin, rpId: challenge.rpId }
          );
        } catch (_) {
          throw apiError(400, 'invalid_mfa_response', 'passkey registration failed');
        }

        const wasEnabled = dbApi.listAdminPasskeys(db, admin.adminId).length > 0;
        dbApi.createAdminPasskey(db, {
          adminId: admin.adminId,
          credentialId: registrationInfo.credential.id,
          name,
          webauthnUserId: adminMfa.webAuthnUserId(admin.adminId),
          publicKey: registrationInfo.credential.publicKey,
          counter: registrationInfo.credential.counter,
          transports: registrationInfo.credential.transports || credential.response?.transports || [],
          deviceType: registrationInfo.credentialDeviceType,
          backedUp: registrationInfo.credentialBackedUp,
        });

        let recoveryCodes = [];
        if (!wasEnabled) {
          recoveryCodes = adminMfa.generateRecoveryCodes();
          dbApi.replaceAdminRecoveryCodes(
            db,
            admin.adminId,
            recoveryCodes.map((code) => adminMfa.hashRecoveryCode(admin.adminId, code))
          );
        }
        req.voxhfAdmin = admin;
        insertAdminAuditEvent(db, req, {
          eventType: wasEnabled ? 'admin.passkey_added' : 'admin.mfa_enabled',
          metadata: { credentialId: registrationInfo.credential.id, name },
        });
        clearHttpAttempts(req, 'admin-mfa-manage');
        return sendJson(req, res, 201, {
          ok: true,
          enabled: true,
          passkeys: publicAdminPasskeys(dbApi.listAdminPasskeys(db, admin.adminId)),
          recoveryCodesRemaining: dbApi.countAdminRecoveryCodes(db, admin.adminId),
          recoveryCodes,
        });
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/mfa/recovery-codes/regenerate') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-manage', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      return withAdminDatabase((db) => {
        requireCurrentAdminPassword(db, admin, body.currentPassword);
        if (!dbApi.listAdminPasskeys(db, admin.adminId).length) {
          throw apiError(409, 'mfa_not_enabled', 'add a passkey before generating recovery codes');
        }
        const recoveryCodes = adminMfa.generateRecoveryCodes();
        dbApi.replaceAdminRecoveryCodes(
          db,
          admin.adminId,
          recoveryCodes.map((code) => adminMfa.hashRecoveryCode(admin.adminId, code))
        );
        req.voxhfAdmin = admin;
        insertAdminAuditEvent(db, req, { eventType: 'admin.recovery_codes_regenerated' });
        clearHttpAttempts(req, 'admin-mfa-manage');
        return sendJson(req, res, 200, {
          ok: true,
          recoveryCodes,
          recoveryCodesRemaining: recoveryCodes.length,
        });
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/mfa/disable') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-manage', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      return withAdminDatabase((db) => {
        requireCurrentAdminPassword(db, admin, body.currentPassword);
        const cleared = dbApi.clearAdminMfa(db, admin.adminId);
        const revoked = dbApi.revokeOtherAdminSessions(db, admin.adminId, admin.sessionId);
        req.voxhfAdmin = admin;
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.mfa_disabled',
          metadata: { passkeys: cleared.passkeys, revokedSessions: revoked.count },
        });
        clearHttpAttempts(req, 'admin-mfa-manage');
        return sendJson(req, res, 200, { ok: true, enabled: false, revokedSessions: revoked.count });
      });
    }

    const removePasskey = url.pathname.match(/^\/admin\/api\/mfa\/passkeys\/([^/]+)\/remove$/);
    if (req.method === 'POST' && removePasskey) {
      if (!allowHttpAttempt(req, res, 'admin-mfa-manage', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const credentialId = decodeURIComponent(removePasskey[1]);
      return withAdminDatabase((db) => {
        requireCurrentAdminPassword(db, admin, body.currentPassword);
        const result = dbApi.deleteAdminPasskey(db, admin.adminId, credentialId);
        if (!result.count) throw apiError(404, 'passkey_not_found', 'passkey not found');
        const remaining = dbApi.listAdminPasskeys(db, admin.adminId);
        if (!remaining.length) dbApi.clearAdminMfa(db, admin.adminId);
        req.voxhfAdmin = admin;
        insertAdminAuditEvent(db, req, {
          eventType: remaining.length ? 'admin.passkey_removed' : 'admin.mfa_disabled',
          metadata: { credentialId },
        });
        clearHttpAttempts(req, 'admin-mfa-manage');
        return sendJson(req, res, 200, {
          ok: true,
          enabled: remaining.length > 0,
          passkeys: publicAdminPasskeys(remaining),
          recoveryCodesRemaining: remaining.length ? dbApi.countAdminRecoveryCodes(db, admin.adminId) : 0,
        });
      });
    }

    return sendJson(req, res, 404, { ok: false, error: 'not found' });
  }

  async function handleAdminAuthApi(req, res, url) {
    // Bootstrap and recovery may use the configured owner token. Routine login
    // creates a scoped HttpOnly admin session and then applies optional MFA.
    if (req.method === 'GET' && url.pathname === '/admin/api/auth/status') {
      const admin = getAdminSessionFromRequest(req);
      const accountCount = RELAY_AUTH_MODE === AUTH_MODE_ENV
        ? 0
        : withAdminDatabase((db) => relayDb.countAdminAccounts(db));
      return sendJson(req, res, 200, {
        ok: true,
        accountLoginAvailable: RELAY_AUTH_MODE !== AUTH_MODE_ENV,
        bootstrapRequired: RELAY_AUTH_MODE !== AUTH_MODE_ENV && accountCount === 0,
        breakGlassAvailable: Boolean(ADMIN_TOKEN_HASH),
        authenticated: Boolean(admin),
        admin: admin ? publicAdminAccount(admin) : null,
      });
    }

    if (RELAY_AUTH_MODE === AUTH_MODE_ENV) {
      return sendJson(req, res, 409, {
        ok: false,
        code: 'admin_accounts_unavailable',
        error: 'admin accounts require sqlite-fallback or sqlite auth mode',
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/bootstrap') {
      if (!allowHttpAttempt(req, res, 'admin-bootstrap', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const tokenAdmin = authorizeAdminTokenRequest(req);
      if (!tokenAdmin.ok) return sendJson(req, res, tokenAdmin.status, { ok: false, error: tokenAdmin.error });
      const body = await readJsonBody(req);
      const username = requireAdminLoginName(body.username);
      const displayName = requireAccountDisplayName(body.displayName || username);
      const password = requireAccountPassword(body.password);

      return withAdminDatabase((db) => {
        if (relayDb.countAdminAccounts(db) > 0) {
          return sendJson(req, res, 409, {
            ok: false,
            code: 'admin_already_bootstrapped',
            error: 'an owner account already exists',
          });
        }
        const account = relayDb.createAdminAccount(db, {
          username,
          displayName,
          passwordHash: hashPassword(password),
          role: 'owner',
        });
        const session = createAdminLoginSession(db, req, account);
        req.voxhfAdmin = { kind: 'session', ...account, ...session };
        insertAdminAuditEvent(db, req, { eventType: 'admin.owner_bootstrapped' });
        clearHttpAttempts(req, 'admin-bootstrap');
        return sendJson(req, res, 201, {
          ok: true,
          admin: publicAdminAccount({ ...account, ...session }),
        }, adminSessionCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/login') {
      if (!allowHttpAttempt(req, res, 'admin-login', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      return withAdminDatabaseAsync(async (db) => {
        const account = isUserId(username)
          ? relayDb.getAdminAccountCredentials(db, username)
          : null;
        if (!account || account.disabledAt || !verifyPassword(password, account.passwordHash)) {
          return sendJson(req, res, 401, {
            ok: false,
            code: 'invalid_credentials',
            error: 'invalid username or password',
          });
        }

        const passkeys = relayDb.listAdminPasskeys(db, account.adminId);
        if (passkeys.length) {
          const challenge = await beginAdminMfaAuthentication(db, req, account, passkeys);
          clearHttpAttempts(req, 'admin-login');
          return sendJson(req, res, 200, {
            ok: true,
            mfaRequired: true,
            flowToken: challenge.flowToken,
            expiresAt: challenge.expiresAt,
            options: challenge.options,
            recoveryAvailable: relayDb.countAdminRecoveryCodes(db, account.adminId) > 0,
          });
        }

        const session = createAdminLoginSession(db, req, account);
        relayDb.setAdminLastLogin(db, account.adminId);
        req.voxhfAdmin = { kind: 'session', ...account, ...session };
        insertAdminAuditEvent(db, req, { eventType: 'admin.login' });
        clearHttpAttempts(req, 'admin-login');
        return sendJson(req, res, 200, {
          ok: true,
          admin: publicAdminAccount({ ...account, ...session }),
        }, adminSessionCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/mfa/passkey') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-login', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const flowToken = String(body.flowToken || '').trim();
      const credential = body.credential;
      if (!isTokenLike(flowToken) || !credential?.id) {
        throw apiError(400, 'invalid_mfa_response', 'passkey response is incomplete');
      }

      return withAdminDatabaseAsync(async (db) => {
        const challenge = relayDb.consumeAdminMfaChallenge(db, {
          flowToken,
          purpose: 'authentication',
        });
        if (!challenge) throw apiError(401, 'mfa_challenge_expired', 'MFA challenge expired; sign in again');

        const account = relayDb.getAdminAccountCredentialsById(db, challenge.adminId);
        const passkey = relayDb.getAdminPasskey(db, challenge.adminId, credential.id);
        if (!account || account.disabledAt || !passkey) {
          throw apiError(401, 'invalid_mfa_response', 'passkey authentication failed');
        }


        let authenticationInfo;
        try {
          authenticationInfo = await adminMfa.completeAuthentication(
            credential,
            challenge.challenge,
            passkey,
            { origin: challenge.origin, rpId: challenge.rpId }
          );
        } catch (_) {
          throw apiError(401, 'invalid_mfa_response', 'passkey authentication failed');
        }

        relayDb.updateAdminPasskeyUsage(db, account.adminId, passkey.credentialId, {
          counter: authenticationInfo.newCounter,
          deviceType: authenticationInfo.credentialDeviceType,
          backedUp: authenticationInfo.credentialBackedUp,
        });
        const session = createAdminLoginSession(db, req, account);
        relayDb.setAdminLastLogin(db, account.adminId);
        req.voxhfAdmin = { kind: 'session', ...account, ...session };
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.login_mfa',
          metadata: { factor: 'passkey', credentialId: passkey.credentialId },
        });
        clearHttpAttempts(req, 'admin-mfa-login');
        return sendJson(req, res, 200, {
          ok: true,
          admin: publicAdminAccount({ ...account, ...session }),
        }, adminSessionCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/mfa/recovery') {
      if (!allowHttpAttempt(req, res, 'admin-mfa-recovery', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const flowToken = String(body.flowToken || '').trim();
      const recoveryCode = adminMfa.normalizeRecoveryCode(body.recoveryCode);
      if (!isTokenLike(flowToken) || !recoveryCode) {
        throw apiError(400, 'invalid_recovery_code', 'recovery code is required');
      }

      return withAdminDatabase((db) => {
        const challenge = relayDb.consumeAdminMfaChallenge(db, {
          flowToken,
          purpose: 'authentication',
        });
        if (!challenge) throw apiError(401, 'mfa_challenge_expired', 'MFA challenge expired; sign in again');
        const account = relayDb.getAdminAccountCredentialsById(db, challenge.adminId);
        const used = account && relayDb.consumeAdminRecoveryCode(
          db,
          account.adminId,
          adminMfa.hashRecoveryCode(account.adminId, recoveryCode)
        );
        if (!account || account.disabledAt || !used?.count) {
          throw apiError(401, 'invalid_recovery_code', 'recovery code is invalid or already used');
        }

        const session = createAdminLoginSession(db, req, account);
        relayDb.setAdminLastLogin(db, account.adminId);
        req.voxhfAdmin = { kind: 'session', ...account, ...session };
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.login_mfa',
          metadata: { factor: 'recovery_code' },
        });
        clearHttpAttempts(req, 'admin-mfa-recovery');
        return sendJson(req, res, 200, {
          ok: true,
          admin: publicAdminAccount({ ...account, ...session }),
        }, adminSessionCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/logout') {
      const admin = getAdminSessionFromRequest(req);
      const token = getAdminSessionTokenFromRequest(req);
      if (admin && token) {
        withAdminDatabase((db) => {
          relayDb.revokeAdminSessionById(db, admin.adminId, admin.sessionId);
          req.voxhfAdmin = admin;
          insertAdminAuditEvent(db, req, { eventType: 'admin.logout' });
        });
      }
      return sendJson(req, res, 200, { ok: true }, clearAdminSessionCookieHeaders(req));
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/auth/me') {
      const admin = getAdminSessionFromRequest(req);
      if (!admin) return sendJson(req, res, 401, { ok: false, code: 'not_authenticated', error: 'not authenticated' });
      return sendJson(req, res, 200, { ok: true, admin: publicAdminAccount(admin) });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/password') {
      const admin = getAdminSessionFromRequest(req);
      if (!admin) return sendJson(req, res, 401, { ok: false, code: 'not_authenticated', error: 'not authenticated' });
      if (!allowHttpAttempt(req, res, 'admin-password', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = requireAccountPassword(body.newPassword);

      return withAdminDatabase((db) => {
        const account = relayDb.getAdminAccountCredentials(db, admin.username);
        if (!account || !verifyPassword(currentPassword, account.passwordHash)) {
          return sendJson(req, res, 401, {
            ok: false,
            code: 'invalid_credentials',
            error: 'current password is incorrect',
          });
        }
        relayDb.setAdminPassword(db, admin.adminId, hashPassword(newPassword));
        const revoked = relayDb.revokeOtherAdminSessions(db, admin.adminId, admin.sessionId);
        req.voxhfAdmin = admin;
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.password_changed',
          metadata: { revokedSessions: revoked.count },
        });
        clearHttpAttempts(req, 'admin-password');
        return sendJson(req, res, 200, { ok: true, revokedSessions: revoked.count });
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/auth/recover') {
      if (!allowHttpAttempt(req, res, 'admin-recovery', MAX_ADMIN_ATTEMPTS_PER_WINDOW)) return;
      const tokenAdmin = authorizeAdminTokenRequest(req);
      if (!tokenAdmin.ok) return sendJson(req, res, tokenAdmin.status, { ok: false, error: tokenAdmin.error });
      const body = await readJsonBody(req);
      const username = requireAdminLoginName(body.username);
      const newPassword = requireAccountPassword(body.newPassword);

      return withAdminDatabase((db) => {
        const account = relayDb.getAdminAccountCredentials(db, username);
        if (!account || account.disabledAt) {
          return sendJson(req, res, 404, { ok: false, code: 'admin_not_found', error: 'admin account not found' });
        }
        relayDb.setAdminPassword(db, account.adminId, hashPassword(newPassword));
        relayDb.revokeAllAdminSessions(db, account.adminId);
        const clearedMfa = relayDb.clearAdminMfa(db, account.adminId);
        const session = createAdminLoginSession(db, req, account);
        req.voxhfAdmin = { kind: 'session', ...account, ...session };
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.break_glass_recovery',
          metadata: { clearedPasskeys: clearedMfa.passkeys },
        });
        clearHttpAttempts(req, 'admin-recovery');
        return sendJson(req, res, 200, {
          ok: true,
          admin: publicAdminAccount({ ...account, ...session }),
        }, adminSessionCookieHeaders(req, session.sessionToken, session.expiresAt));
      });
    }

    return sendJson(req, res, 404, { ok: false, error: 'not found' });
  }

  function authorizeAdminRequest(req) {
    const session = getAdminSessionFromRequest(req);
    if (session) return { ok: true, kind: 'session', ...session };
    return authorizeAdminTokenRequest(req);
  }

  function withAdminDatabase(callback) {
    // Synchronous handlers keep their database handle scoped to one request.
    const db = openDatabase();
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  async function withAdminDatabaseAsync(callback) {
    // WebAuthn helpers are asynchronous, so the handle must remain open until
    // credential verification resolves and then close in the same finally path.
    const db = openDatabase();
    try {
      return await callback(db);
    } finally {
      db.close();
    }
  }

  async function beginAdminMfaAuthentication(db, req, account, passkeys) {
    let context;
    try {
      context = adminMfa.resolveWebAuthnContext(req, {
        allowedOrigins: ALLOWED_ORIGINS,
        rpId: WEBAUTHN_RP_ID,
        rpName: WEBAUTHN_RP_NAME,
      });
    } catch (err) {
      throw apiError(400, 'webauthn_configuration_error', err.message);
    }

    const authenticationOptions = await adminMfa.createAuthenticationOptions(passkeys, context);
    const flowToken = generateRelayToken();
    const expiresAt = new Date(Date.now() + ADMIN_MFA_CHALLENGE_TTL_MS).toISOString();
    relayDb.createAdminMfaChallenge(db, {
      adminId: account.adminId,
      flowToken,
      purpose: 'authentication',
      challenge: authenticationOptions.challenge,
      origin: context.origin,
      rpId: context.rpId,
      expiresAt,
    });
    return { flowToken, expiresAt, options: authenticationOptions };
  }

  function requireCurrentAdminPassword(db, admin, value) {
    const account = relayDb.getAdminAccountCredentialsById(db, admin.adminId);
    if (!account || account.disabledAt || !verifyPassword(String(value || ''), account.passwordHash)) {
      throw apiError(401, 'invalid_credentials', 'current password is incorrect');
    }
    return account;
  }

  function requirePasskeyName(value) {
    const name = String(value || '').trim();
    if (!name || name.length > 60) {
      throw apiError(400, 'invalid_passkey_name', 'passkey name must be 1-60 characters');
    }
    return name;
  }

  function publicAdminPasskeys(passkeys) {
    return passkeys.map((passkey) => ({
      credentialId: passkey.credentialId,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    }));
  }

  function publicAdminAccount(admin) {
    return {
      username: admin.username,
      displayName: admin.displayName || admin.username,
      role: admin.role,
      expiresAt: admin.expiresAt,
    };
  }

  function defaultRelayDatabasePath() {
    return relayDb.defaultDatabasePath();
  }

  function listAdminRelayUsers(db) {
    return relayDb.listRelayUserSummaries(db).map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      createdAt: row.createdAt,
      disabledAt: row.disabledAt,
      tokenCount: row.tokenCount || 0,
      activeTokenCount: row.activeTokenCount || 0,
      activeTokenPrefixes: row.activeTokenPrefixes ? row.activeTokenPrefixes.split(',') : [],
    }));
  }

  function listAdminAuditEvents(db) {
    return relayDb.listAuditEvents(db, { limit: 120 }).map((row) => ({
      auditId: row.auditId,
      userId: row.userId || null,
      actorType: row.actorType,
      actorId: row.actorId,
      eventType: row.eventType,
      ipAddress: row.ipAddress,
      targetAgentId: row.targetAgentId,
      targetBrowserPairingId: row.targetBrowserPairingId,
      commandType: row.commandType,
      createdAt: row.createdAt,
      metadata: parseAuditMetadata(row.metadataJson),
    }));
  }

  function getAdminRelayUser(db, userId) {
    return relayDb.getRelayUser(db, userId);
  }

  function importAdminRelayUserToken(db, input) {
    return relayDb.importRelayUserToken(db, {
      ...input,
      tokenName: 'VoxHF agent token',
    });
  }

  function revokeAdminRelayUserTokens(db, input) {
    return relayDb.revokeRelayUserTokens(db, {
      ...input,
      tokenName: 'VoxHF agent token',
    });
  }

  function setAdminRelayUserDisabled(db, userId, disabled) {
    return relayDb.setRelayUserDisabled(db, userId, disabled);
  }

  function deleteAdminRelayUser(db, userId) {
    return relayDb.deleteRelayUser(db, userId);
  }

  function revokeAdminRelayPairing(db, pairingId) {
    return relayDb.revokeBrowserPairingById(db, pairingId);
  }

  function insertAdminAuditEvent(db, req, input) {
    if (!PERSIST_AUDIT) return;
    try {
      const actor = req.voxhfAdmin;
      relayDb.insertAuditEvent(db, {
        ...input,
        actorType: 'admin',
        actorId: actor?.username || actor?.actorId || 'admin-token',
        ipAddress: getRequestIp(req),
      });
    } catch (err) {
      console.warn(`[relay-audit] Could not write admin audit event: ${err.message}`);
    }
  }

  function requireAdminUserId(userId) {
    const value = String(userId || '').trim();
    if (!isUserId(value)) throw new Error('invalid user id');
    return value;
  }

  function requireAdminLoginName(value) {
    const username = String(value || '').trim().toLowerCase();
    if (!isUserId(username)) {
      throw apiError(
        400,
        'invalid_username',
        'Use a 2-48 character username: letters, numbers, dot, underscore, or dash.'
      );
    }
    return username;
  }

  function getRequestIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket.remoteAddress || '';
  }

  function generateAccountRecoveryCode() {
    const groups = crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g);
    return `VHF-RESET-${groups.join('-')}`;
  }

  function parseAuditMetadata(metadataJson) {
    if (!metadataJson) return {};
    try {
      const parsed = JSON.parse(metadataJson);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function isTokenLike(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(value);
  }

  function apiError(status, code, message) {
    const err = new Error(message);
    err.name = 'ApiError';
    err.status = status;
    err.code = code;
    err.isApiError = true;
    return err;
  }

  return handleAdminApi;
}

module.exports = { createAdminApi };
