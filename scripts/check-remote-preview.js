// Remote preview preflight.
//
// This checks the local relay environment, config.json remote-agent settings,
// and the relay health endpoint. It does not connect to IVAO or Altitude; it is
// a quick sanity check before opening the remote webapp.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { readEnvFile } = require('./env-file');

const root = path.resolve(__dirname, '..');
const relayEnvPath = process.env.VOXHF_RELAY_ENV_FILE || path.join(root, 'apps', 'relay', '.env');
const configPath = path.join(root, 'config.json');

let failures = 0;
let warnings = 0;

function ok(label, detail = '') {
  console.log(`[OK] ${label}${detail ? `: ${detail}` : ''}`);
}

function warn(label, detail = '') {
  warnings += 1;
  console.log(`[WARN] ${label}${detail ? `: ${detail}` : ''}`);
}

function fail(label, detail = '') {
  failures += 1;
  console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ''}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relayConnectHost(host) {
  return !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function relayWsUrl(host, port) {
  return `ws://${relayConnectHost(host)}:${port}`;
}

function relayHealthUrl(host, port) {
  return `http://${relayConnectHost(host)}:${port}/health`;
}

function normalizeWsBase(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    url.search = '';
    url.hash = '';
    url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function requestJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(body) });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, error: 'invalid json response' });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function main() {
  const envExists = fs.existsSync(relayEnvPath);
  if (envExists) ok('relay env file', path.relative(root, relayEnvPath));
  else fail('relay env file', 'copy apps/relay/.env.example to apps/relay/.env');

  const relayEnv = { ...process.env, ...readEnvFile(relayEnvPath) };
  const relayHost = relayEnv.VOXHF_RELAY_HOST || '127.0.0.1';
  const relayPort = Number(relayEnv.VOXHF_RELAY_PORT || 8787);
  const relayToken = relayEnv.VOXHF_RELAY_TOKEN || '';
  const relayUrl = relayWsUrl(relayHost, relayPort);
  const healthUrl = relayHealthUrl(relayHost, relayPort);

  if (relayToken && relayToken !== 'change-this-dev-token') ok('relay token configured', redact(relayToken));
  else warn('relay token', 'set VOXHF_RELAY_TOKEN to a non-example value before serious testing');

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = readJson(configPath);
      ok('config.json', 'valid JSON');
    } catch (err) {
      fail('config.json', err.message);
    }
  } else {
    fail('config.json', 'missing');
  }

  if (config.remoteAgentEnabled === true) ok('remoteAgentEnabled', 'true');
  else fail('remoteAgentEnabled', 'set config.json remoteAgentEnabled to true');

  if (config.remoteRelayToken && relayToken && config.remoteRelayToken === relayToken) ok('remoteRelayToken', 'matches relay env token');
  else fail('remoteRelayToken', 'config.json token must match apps/relay/.env');

  const configRelay = normalizeWsBase(config.remoteRelayUrl || '');
  const expectedRelay = normalizeWsBase(relayUrl);
  if (configRelay && configRelay === expectedRelay) ok('remoteRelayUrl', config.remoteRelayUrl);
  else if (config.remoteRelayUrl) warn('remoteRelayUrl', `configured ${config.remoteRelayUrl}, expected local preview ${relayUrl}`);
  else fail('remoteRelayUrl', `set config.json remoteRelayUrl to ${relayUrl}`);

  const health = await requestJson(healthUrl);
  if (health.ok && health.body?.ok) {
    ok('relay health', `${healthUrl} clients=${health.body.clients} devices=${health.body.devices} pairings=${health.body.persistedPairings}`);
  } else {
    fail('relay health', `start the relay with npm.cmd run relay:env (${health.error || `HTTP ${health.status}`})`);
  }

  printNextSteps(relayUrl, relayToken);

  if (failures) {
    console.log(`\n${failures} remote preview check(s) failed, ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`\nRemote preview preflight passed with ${warnings} warning(s).`);
}

function redact(value) {
  const text = String(value);
  if (text.length <= 8) return '***';
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function printNextSteps(relayUrl, relayToken) {
  console.log('\nRemote preview values');
  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Relay Token: ${relayToken ? `${redact(relayToken)} (copy the full value from apps/relay/.env)` : '(missing)'}`);
  console.log('Local remote-preview URL: http://localhost:3000/?remote=1');
  console.log('\nThen:');
  console.log('1. Start the proxy with npm.cmd start or start.bat.');
  console.log('2. Wait for [REMOTE] Browser pairing code: ABC-123 in the proxy console.');
  console.log('3. Open the local remote-preview URL above.');
  console.log('4. In Settings > Remote, enter Relay URL, Relay Token, and Pairing Code.');
  console.log('5. Press Apply Remote, then Pair Browser if needed.');
}

main().catch((err) => {
  fail('remote preflight crashed', err.stack || err.message);
  process.exit(1);
});
