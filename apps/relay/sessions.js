'use strict';

const relayDb = require('./db');

/**
 * Owns account/admin session lookup and cookie construction. Database records
 * remain the source of truth; cookies carry opaque tokens and preserve their
 * distinct path and SameSite boundaries.
 */
function createRelaySessions(options = {}) {
  const {
    authMode,
    envAuthMode,
    accountCookieName,
    accountTtlMs,
    adminCookieName,
    adminTtlMs,
    adminIdleTtlMs,
    storeMetadata,
    openDatabase,
    generateToken,
    logger = console,
  } = options;

  if (typeof openDatabase !== 'function') throw new TypeError('openDatabase is required');
  if (typeof generateToken !== 'function') throw new TypeError('generateToken is required');

  function createAccountSession(db, req, userId) {
    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + accountTtlMs).toISOString();
    const session = relayDb.createBrowserSession(db, {
      userId,
      sessionToken,
      expiresAt,
      browserIdHash: '',
      ...requestMetadata(req),
    });

    return {
      ...session,
      userName: session.displayName || session.userId,
      sessionToken,
    };
  }

  function createAdminSession(db, req, account) {
    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + adminTtlMs).toISOString();
    const session = relayDb.createAdminSession(db, {
      adminId: account.adminId,
      sessionToken,
      expiresAt,
      ...requestMetadata(req),
    });
    return { ...session, sessionToken };
  }

  function getAccountSession(req) {
    const token = getAccountToken(req);
    if (!token || authMode === envAuthMode) return null;

    try {
      return withDatabase((db) => {
        const session = relayDb.getBrowserSession(db, token);
        if (!session) return null;
        return {
          sessionId: session.sessionId,
          userId: session.userId,
          userName: session.displayName || session.userId,
          expiresAt: session.expiresAt,
        };
      });
    } catch (err) {
      logger.warn(`[relay-account] Could not read browser session: ${err.message}`);
      return null;
    }
  }

  function getAdminSession(req) {
    const token = getAdminToken(req);
    if (!token || authMode === envAuthMode) return null;
    try {
      return withDatabase((db) => relayDb.getAdminSession(db, token, {
        idleTtlMs: adminIdleTtlMs,
      }));
    } catch (err) {
      logger.warn(`[relay-admin] Could not read admin session: ${err.message}`);
      return null;
    }
  }

  function findRelayUserBySession(req) {
    const session = getAccountSession(req);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      userName: session.userName || session.userId,
    };
  }

  function accountCookieHeaders(req, sessionToken, expiresAt) {
    return {
      'set-cookie': buildCookie(req, accountCookieName, sessionToken, {
        path: '/',
        sameSite: 'Lax',
        maxAgeSeconds: secondsUntil(expiresAt),
      }),
    };
  }

  function clearAccountCookieHeaders(req) {
    return {
      'set-cookie': buildCookie(req, accountCookieName, '', {
        path: '/',
        sameSite: 'Lax',
        maxAgeSeconds: 0,
      }),
    };
  }

  function adminCookieHeaders(req, sessionToken, expiresAt) {
    return {
      'set-cookie': buildCookie(req, adminCookieName, sessionToken, {
        path: '/admin',
        sameSite: 'Strict',
        maxAgeSeconds: secondsUntil(expiresAt),
      }),
    };
  }

  function clearAdminCookieHeaders(req) {
    return {
      'set-cookie': buildCookie(req, adminCookieName, '', {
        path: '/admin',
        sameSite: 'Strict',
        maxAgeSeconds: 0,
      }),
    };
  }

  function getAccountToken(req) {
    return parseCookies(req.headers.cookie || '')[accountCookieName] || '';
  }

  function getAdminToken(req) {
    return parseCookies(req.headers.cookie || '')[adminCookieName] || '';
  }

  function requestMetadata(req) {
    if (!storeMetadata) return { ipAddress: '', userAgent: '' };
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return {
      ipAddress: forwarded || req.socket.remoteAddress || '',
      userAgent: req.headers['user-agent'] || '',
    };
  }

  function withDatabase(callback) {
    const db = openDatabase();
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  return Object.freeze({
    createAccountSession,
    createAdminSession,
    getAccountSession,
    getAdminSession,
    findRelayUserBySession,
    getAccountToken,
    getAdminToken,
    accountCookieHeaders,
    clearAccountCookieHeaders,
    adminCookieHeaders,
    clearAdminCookieHeaders,
  });
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function buildCookie(req, name, value, options) {
  // TLS normally terminates at Caddy, so Secure follows either the socket or
  // the trusted reverse-proxy scheme header while HttpOnly is unconditional.
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    'HttpOnly',
    `SameSite=${options.sameSite}`,
    `Max-Age=${Math.max(0, Number(options.maxAgeSeconds || 0))}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function isSecureRequest(req) {
  return req.socket.encrypted
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function secondsUntil(expiresAt) {
  return Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

module.exports = { createRelaySessions };
