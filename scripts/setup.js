'use strict';

/**
 * Interactive first-run setup for the local agent and self-hosted server.
 *
 * The wizard only generates files already consumed by VoxHF. It deliberately
 * avoids installing software or changing DNS/firewall rules, so every external
 * system change remains visible and under the operator's control.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_EXAMPLE = path.join(ROOT, 'config.example.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SERVER_ENV_EXAMPLE = path.join(ROOT, 'infra', 'docker', '.env.example');
const SERVER_ENV_FILE = path.join(ROOT, 'infra', 'docker', '.env');

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    printHeader();
    const choices = availableFlows();
    const requestedFlow = process.argv[2];
    const normalizedRequest = normalizeFlow(requestedFlow);
    if (requestedFlow && !normalizedRequest) throw new Error(`Unknown setup mode: ${requestedFlow}`);
    if (normalizedRequest && !choices.some(([id]) => id === normalizedRequest)) {
      throw new Error(`Setup mode "${normalizedRequest}" is not included in this package.`);
    }
    const flow = normalizedRequest || await choose(input, 'What do you want to configure?', choices);

    if (flow === 'local') await setupLocal(input, false);
    if (flow === 'agent') await setupLocal(input, true);
    if (flow === 'server') await setupServer(input);
  } finally {
    input.close();
  }
}

async function setupLocal(input, remoteEnabled) {
  const current = readJsonIfPresent(CONFIG_FILE);
  const base = current || readJson(CONFIG_EXAMPLE);

  if (current && !await confirm(input, 'config.json already exists. Update it?', false)) {
    console.log('\nNo files changed.');
    return;
  }

  const config = { ...base };
  config.lanIp = '';
  config.voiceDiagnostics = false;
  config.webTxEnabled = true;
  config.remoteAgentEnabled = remoteEnabled;

  if (remoteEnabled) {
    config.remoteRelayUrl = await askValidated(
      input,
      'Relay URL (for example wss://relay.example.com)',
      config.remoteRelayUrl,
      validateRelayUrl
    );
    config.remoteRelayToken = await askRequired(input, 'Agent token', config.remoteRelayToken);
    config.remoteDeviceName = await askRequired(
      input,
      'Name shown for this simulator PC',
      config.remoteDeviceName || 'Simulator PC'
    );
  } else {
    config.remoteRelayUrl = '';
    config.remoteRelayToken = '';
    config.remoteDeviceName = '';
  }

  writePrivateFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nCreated ${relative(CONFIG_FILE)}`);
  printDependencyStatus();
  console.log('\nNext:');
  console.log('  1. Run npm.cmd start (or double-click start.bat).');
  console.log('  2. Enter the IPv4 address printed by VoxHF in PilotUI.');
  console.log('  3. Open http://localhost:3000.');
  if (remoteEnabled) {
    console.log('  4. Open your self-hosted app and sign in or complete manual pairing.');
  }
}

async function setupServer(input) {
  if (fs.existsSync(SERVER_ENV_FILE)
      && !await confirm(input, 'infra/docker/.env already exists. Replace it?', false)) {
    console.log('\nNo files changed.');
    return;
  }

  const baseDomain = (await askValidated(
    input,
    'Base domain (for example example.com)',
    '',
    validateDomain
  )).toLowerCase();
  const email = await askValidated(input, 'Email for TLS certificate notices', '', validateEmail);
  const mode = await choose(input, 'Access model', [
    ['private', 'Private token (simplest, one owner)'],
    ['accounts', 'Accounts with invite-only registration'],
  ]);

  const values = createServerValues({ baseDomain, email, mode });
  const template = fs.readFileSync(SERVER_ENV_EXAMPLE, 'utf8');
  const envText = replaceEnvValues(template, values);
  writePrivateFile(SERVER_ENV_FILE, envText);

  console.log(`\nCreated ${relative(SERVER_ENV_FILE)}`);
  console.log('\nCreate DNS A/AAAA records pointing to this VPS:');
  console.log(`  ${baseDomain}`);
  console.log(`  app.${baseDomain}`);
  console.log(`  relay.${baseDomain}`);
  console.log('\nThen start VoxHF:');
  console.log('  docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d --build');
  console.log('  docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env ps');
  console.log(`  Health: https://relay.${baseDomain}/health`);

  if (mode === 'private') {
    console.log('\nPrivate relay token (store it in a password manager):');
    console.log(`  ${values.VOXHF_RELAY_TOKEN}`);
    console.log('\nOn the simulator PC run npm.cmd run setup -- agent and enter:');
    console.log(`  Relay URL: wss://relay.${baseDomain}`);
    console.log('  Agent token: the private relay token shown above');
  } else {
    console.log('\nAdmin token (shown once here; store it in a password manager):');
    console.log(`  ${values.VOXHF_RELAY_ADMIN_TOKEN}`);
    console.log('\nAfter the containers start:');
    console.log(`  1. Open https://relay.${baseDomain}/admin and create the owner account.`);
    console.log('  2. Create a registration invite from the Access section.');
    console.log(`  3. Register at https://app.${baseDomain}/register.`);
    console.log('  4. Save the one-time agent token shown after registration.');
    console.log('  5. On the simulator PC run npm.cmd run setup -- agent.');
  }
}

function createServerValues({ baseDomain, email, mode }) {
  const accounts = mode === 'accounts';
  return {
    LANDING_DOMAIN: baseDomain,
    WEBAPP_DOMAIN: `app.${baseDomain}`,
    RELAY_DOMAIN: `relay.${baseDomain}`,
    CADDY_ACME_EMAIL: email,
    VOXHF_ALLOWED_ORIGINS: `https://app.${baseDomain},https://relay.${baseDomain}`,
    VOXHF_RELAY_TOKEN: accounts ? '' : randomToken(),
    VOXHF_RELAY_ADMIN_TOKEN: accounts ? randomToken() : '',
    VOXHF_RELAY_AUTH_MODE: accounts ? 'sqlite' : 'env',
    VOXHF_RELAY_ENABLE_REGISTRATION: accounts ? 'true' : 'false',
  };
}

function replaceEnvValues(template, values) {
  const remaining = new Set(Object.keys(values));
  const lines = String(template).split(/\r?\n/).map((line) => {
    const match = line.match(/^#?\s*([A-Z0-9_]+)=/);
    if (!match || !remaining.has(match[1])) return line;
    const key = match[1];
    remaining.delete(key);
    return `${key}=${values[key]}`;
  });

  if (remaining.size) {
    lines.push('', '# Values added by the setup wizard.');
    for (const key of remaining) lines.push(`${key}=${values[key]}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function choose(input, question, choices) {
  while (true) {
    console.log(`\n${question}`);
    choices.forEach(([, label], index) => console.log(`  ${index + 1}. ${label}`));
    const answer = (await input.question('Choose: ')).trim();
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index][0];
    console.log(`Enter a number from 1 to ${choices.length}.`);
  }
}

async function confirm(input, question, defaultValue) {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  const answer = (await input.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

async function askRequired(input, question, defaultValue = '') {
  return askValidated(input, question, defaultValue, (value) => value ? '' : 'A value is required.');
}

async function askValidated(input, question, defaultValue, validate) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await input.question(`${question}${suffix}: `)).trim() || defaultValue;
    const error = validate(answer);
    if (!error) return answer;
    console.log(error);
  }
}

function validateRelayUrl(value) {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)
      ? ''
      : 'Use a ws://, wss://, http://, or https:// URL.';
  } catch (_) {
    return 'Enter a valid relay URL.';
  }
}

function validateDomain(value) {
  const domain = String(value).trim().toLowerCase();
  if (/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return '';
  return 'Enter only a valid domain, without protocol or path.';
}

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)) ? '' : 'Enter a valid email address.';
}

function normalizeFlow(value) {
  const flow = String(value || '').toLowerCase();
  return ['local', 'agent', 'server'].includes(flow) ? flow : '';
}

function availableFlows() {
  const flows = [];
  if (fs.existsSync(CONFIG_EXAMPLE)) {
    flows.push(['local', 'Local agent only']);
    flows.push(['agent', 'Connect this PC to a self-hosted server']);
  }
  if (fs.existsSync(SERVER_ENV_EXAMPLE)) flows.push(['server', 'Prepare a self-hosted server']);
  if (!flows.length) throw new Error('This package does not contain a setup template.');
  return flows;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonIfPresent(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  return !result.error && result.status === 0;
}

function printDependencyStatus() {
  const ffmpeg = commandAvailable('ffmpeg', ['-version']);
  console.log('\nDependency check:');
  console.log(`  Node.js ${process.versions.node}: OK`);
  console.log(`  ffmpeg: ${ffmpeg ? 'OK' : 'NOT FOUND'}`);
  if (!ffmpeg) console.log('  Install it on Windows with: winget install Gyan.FFmpeg');
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function printHeader() {
  console.log('\nVoxHF setup');
  console.log('-----------');
}

function printHelp() {
  console.log('Usage: npm run setup -- [local|agent|server]');
  console.log('  local   Configure the local Altitude agent only');
  console.log('  agent   Connect this agent to an existing self-hosted relay');
  console.log('  server  Generate infra/docker/.env for a self-hosted server');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nSetup failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServerValues,
  availableFlows,
  normalizeFlow,
  replaceEnvValues,
  validateDomain,
  validateEmail,
  validateRelayUrl,
};
