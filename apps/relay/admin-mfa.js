'use strict';

// WebAuthn performs the cryptographic work for optional admin MFA. This module
// keeps protocol-specific details out of the HTTP router and deliberately does
// not decide whether MFA is enabled: an account opts in by storing a passkey.

const crypto = require('crypto');
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require('@simplewebauthn/server');

const DEFAULT_RP_NAME = 'VoxHF Relay';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function resolveWebAuthnContext(req, options = {}) {
  const origin = requestOrigin(req);
  const allowedOrigins = options.allowedOrigins || [];
  if (!allowedOrigins.includes(origin)) throw new Error('WebAuthn origin is not allowed');

  const parsed = new URL(origin);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !local) {
    throw new Error('WebAuthn requires HTTPS outside localhost');
  }

  const configuredRpId = String(options.rpId || '').trim().toLowerCase();
  const rpId = configuredRpId || parsed.hostname.toLowerCase();
  if (!isRpIdForHost(rpId, parsed.hostname.toLowerCase())) {
    throw new Error('WebAuthn RP ID does not match the admin origin');
  }

  return {
    origin,
    rpId,
    rpName: String(options.rpName || DEFAULT_RP_NAME).trim() || DEFAULT_RP_NAME,
  };
}

async function createRegistrationOptions(account, passkeys, context) {
  return generateRegistrationOptions({
    rpName: context.rpName,
    rpID: context.rpId,
    userID: webAuthnUserIdBytes(account.adminId),
    userName: account.username,
    userDisplayName: account.displayName || account.username,
    attestationType: 'none',
    excludeCredentials: passkeys.map(publicCredentialDescriptor),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    timeout: 60_000,
  });
}

function webAuthnUserId(adminId) {
  return webAuthnUserIdBytes(adminId).toString('base64url');
}

function webAuthnUserIdBytes(adminId) {
  return crypto.createHash('sha256').update(String(adminId)).digest();
}

async function completeRegistration(response, challenge, context) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: context.origin,
    expectedRPID: context.rpId,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration could not be verified');
  }
  return verification.registrationInfo;
}

async function createAuthenticationOptions(passkeys, context) {
  return generateAuthenticationOptions({
    rpID: context.rpId,
    allowCredentials: passkeys.map(publicCredentialDescriptor),
    userVerification: 'required',
    timeout: 60_000,
  });
}

async function completeAuthentication(response, challenge, passkey, context) {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: context.origin,
    expectedRPID: context.rpId,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: Number(passkey.counter || 0),
      transports: parseTransports(passkey.transports),
    },
  });
  if (!verification.verified) throw new Error('Passkey authentication could not be verified');
  return verification.authenticationInfo;
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(15);
    let raw = '';
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
  });
}

function hashRecoveryCode(adminId, code) {
  const normalized = normalizeRecoveryCode(code);
  return crypto.createHash('sha256').update(`${adminId}:${normalized}`).digest('hex');
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseTransports(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function publicCredentialDescriptor(passkey) {
  return {
    id: passkey.credentialId,
    transports: parseTransports(passkey.transports),
  };
}

function requestOrigin(req) {
  const explicit = String(req.headers.origin || '').trim();
  if (explicit) return new URL(explicit).origin;
  const protocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) throw new Error('WebAuthn request host is missing');
  return new URL(`${protocol}://${host}`).origin;
}

function isRpIdForHost(rpId, hostname) {
  return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

module.exports = {
  resolveWebAuthnContext,
  createRegistrationOptions,
  completeRegistration,
  createAuthenticationOptions,
  completeAuthentication,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  parseTransports,
  webAuthnUserId,
};
