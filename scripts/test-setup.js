'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  availableFlows,
  createServerValues,
  normalizeFlow,
  replaceEnvValues,
  validateDomain,
  validateEmail,
  validateRelayUrl,
} = require('./setup');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'infra', 'docker', '.env.example'), 'utf8');
const defaults = fs.readFileSync(path.join(root, 'infra', 'docker', 'defaults.env'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'infra', 'docker', 'docker-compose.yml'), 'utf8');

assert.strictEqual(normalizeFlow('LOCAL'), 'local');
assert.strictEqual(normalizeFlow('unknown'), '');
assert.strictEqual(validateDomain('example.com'), '');
assert.notStrictEqual(validateDomain('https://example.com'), '');
assert.strictEqual(validateEmail('owner@example.com'), '');
assert.notStrictEqual(validateEmail('owner'), '');
assert.strictEqual(validateRelayUrl('wss://relay.example.com'), '');
assert.notStrictEqual(validateRelayUrl('ftp://relay.example.com'), '');
assert.deepStrictEqual(availableFlows().map(([id]) => id), ['local', 'agent', 'server']);

const privateValues = createServerValues({
  baseDomain: 'example.com',
  email: 'owner@example.com',
  mode: 'private',
});
assert.strictEqual(privateValues.VOXHF_RELAY_AUTH_MODE, 'env');
assert.strictEqual(privateValues.VOXHF_RELAY_ENABLE_REGISTRATION, 'false');
assert.match(privateValues.VOXHF_RELAY_TOKEN, /^[a-f0-9]{64}$/);
assert.strictEqual(privateValues.VOXHF_RELAY_ADMIN_TOKEN, '');
assert.ok(!Object.hasOwn(privateValues, 'VOXHF_RELAY_REQUIRE_PAIRING'));
assert.ok(!Object.hasOwn(privateValues, 'VOXHF_RELAY_STORE_SESSION_METADATA'));

const accountValues = createServerValues({
  baseDomain: 'example.com',
  email: 'owner@example.com',
  mode: 'accounts',
});
assert.strictEqual(accountValues.VOXHF_RELAY_AUTH_MODE, 'sqlite');
assert.strictEqual(accountValues.VOXHF_RELAY_ENABLE_REGISTRATION, 'true');
assert.strictEqual(accountValues.VOXHF_RELAY_TOKEN, '');
assert.match(accountValues.VOXHF_RELAY_ADMIN_TOKEN, /^[a-f0-9]{64}$/);
assert.strictEqual(
  accountValues.VOXHF_ALLOWED_ORIGINS,
  'https://app.example.com,https://relay.example.com'
);

const generated = replaceEnvValues(template, accountValues);
for (const [key, value] of Object.entries(accountValues)) {
  assert.ok(generated.includes(`${key}=${value}`), `${key} was not written`);
}
assert.ok(!generated.includes('LANDING_DOMAIN=voxhf.com'));
assert.ok(!generated.includes('VOXHF_RELAY_REQUIRE_PAIRING='));
assert.ok(!generated.includes('VOXHF_RELAY_STORE_SESSION_METADATA='));

for (const expected of [
  'VOXHF_RELAY_REQUIRE_PAIRING=true',
  'VOXHF_RELAY_STORE_SESSION_METADATA=false',
  'VOXHF_RELAY_PERSIST_AUDIT=false',
  'VOXHF_RELAY_MAX_AUTH_ATTEMPTS_PER_WINDOW=10',
  'VOXHF_RELAY_MAX_ADMIN_ATTEMPTS_PER_WINDOW=20',
  'VOXHF_RELAY_MAX_AUDIO_FRAME_BYTES=32768',
  'VOXHF_UPDATE_DOWNLOAD_URL=https://github.com/leledeste/voxhf/releases/latest',
]) {
  assert.ok(defaults.includes(expected), `${expected} is missing from defaults.env`);
}
for (const privateKey of [
  'LANDING_DOMAIN=',
  'CADDY_ACME_EMAIL=',
  'VOXHF_RELAY_TOKEN=',
  'VOXHF_RELAY_ADMIN_TOKEN=',
  'VOXHF_ALLOWED_ORIGINS=',
]) {
  assert.ok(!defaults.includes(privateKey), `${privateKey} must not be tracked in defaults.env`);
}

const defaultsPosition = compose.indexOf('      - defaults.env');
const privatePosition = compose.indexOf('      - .env');
assert.ok(defaultsPosition >= 0, 'docker-compose.yml does not load defaults.env');
assert.ok(privatePosition > defaultsPosition, 'private .env must override defaults.env');

console.log('Setup configuration tests passed.');
