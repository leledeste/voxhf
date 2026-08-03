'use strict';

const crypto = require('crypto');

/**
 * Shared account and owner credential policy. Password hashes retain their
 * algorithm marker for future migration, and verification uses a constant-time
 * comparison after deriving an equal-length key.
 */
function isUserId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{2,48}$/.test(value);
}

function requireAccountUserId(value) {
  const userId = String(value || '').trim().toLowerCase();
  if (!isUserId(userId)) {
    throw apiError(
      400,
      'invalid_username',
      'Use a 2-48 character username: letters, numbers, dot, underscore, or dash.'
    );
  }
  return userId;
}

function requireAccountDisplayName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) {
    throw apiError(400, 'invalid_display_name', 'Display name must be 1-80 characters.');
  }
  return text;
}

function requireAccountPassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 256) {
    throw apiError(400, 'invalid_password', 'Password must be 10-256 characters.');
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  // Derive exactly the stored key length before comparing so timingSafeEqual
  // never throws on attacker-controlled or legacy database values.
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password || ''), parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeAccountRecoveryCode(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^VHFRESET[A-F0-9]{32}$/.test(normalized) ? normalized : '';
}

function apiError(status, code, message) {
  const err = new Error(message);
  err.name = 'ApiError';
  err.status = status;
  err.code = code;
  err.isApiError = true;
  return err;
}

module.exports = {
  isUserId,
  requireAccountUserId,
  requireAccountDisplayName,
  requireAccountPassword,
  hashPassword,
  verifyPassword,
  normalizeAccountRecoveryCode,
};
