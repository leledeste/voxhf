'use strict';

// Check the public pieces required before a real passkey ceremony. This does
// not pretend to replace Face ID, Touch ID, Windows Hello, or a security key;
// those authenticators must still complete the manual matrix in the docs.

const assert = require('assert');

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  const base = normalizeBaseUrl(process.argv[2] || process.env.VOXHF_RELAY_PUBLIC_URL);
  if (!base) {
    throw new Error('Usage: npm run relay:mfa:preflight -- https://relay.example.com');
  }

  const health = await get(base, '/health');
  assert.strictEqual(health.response.status, 200, '/health should return HTTP 200');
  assert.strictEqual(health.json?.service, 'voxhf-relay', '/health should identify voxhf-relay');
  console.log('[OK] relay health');

  const admin = await get(base, '/admin');
  assert.strictEqual(admin.response.status, 200, '/admin should return HTTP 200');
  assert.match(admin.text, /\/admin\/webauthn\.js/, 'admin page should load the self-hosted WebAuthn client');
  console.log('[OK] admin page and WebAuthn reference');

  const webauthn = await get(base, '/admin/webauthn.js');
  assert.strictEqual(webauthn.response.status, 200, 'WebAuthn client should return HTTP 200');
  assert.match(webauthn.response.headers.get('content-type') || '', /javascript/i, 'WebAuthn client should be JavaScript');
  assert.match(webauthn.text, /SimpleWebAuthnBrowser/, 'WebAuthn browser bundle should expose SimpleWebAuthnBrowser');
  console.log('[OK] self-hosted WebAuthn client');

  const status = await get(base, '/admin/api/auth/status');
  assert.strictEqual(status.response.status, 200, 'admin auth status should return HTTP 200');
  assert.strictEqual(status.json?.ok, true, 'admin auth status should return ok=true');
  console.log('[OK] admin authentication API');

  if (base.protocol === 'https:') {
    assert.ok(admin.response.headers.get('strict-transport-security'), 'HTTPS admin page should include HSTS');
    assert.ok(admin.response.headers.get('content-security-policy'), 'HTTPS admin page should include a Content-Security-Policy');
    assert.match(admin.response.headers.get('x-frame-options') || '', /DENY/i, 'admin page should deny framing');
    console.log('[OK] production browser security headers');
  }

  console.log('\nPreflight passed. Complete docs/MFA_TESTING.md with a real authenticator.');
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch (_) {
    return null;
  }
}

async function get(base, pathname) {
  const url = new URL(pathname, base);
  const response = await fetch(url, { redirect: 'follow', cache: 'no-store' });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { response, text, json };
}
