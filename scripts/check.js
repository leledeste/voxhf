// Lightweight project health check.
//
// This script intentionally avoids external tooling. It verifies the files a
// GitHub checkout needs, checks Node syntax for the proxy, checks the inline
// browser scripts, and validates JSON files.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve from the repository root even when the script is launched from a
// different working directory.
const root = path.resolve(__dirname, '..');

// These files describe or run the current public package.
const requiredFiles = [
  'README.md',
  'CLAUDE.md',
  'docs/README.md',
  'docs/ROADMAP.md',
  'docs/SELF_HOSTING.md',
  'docs/DEVELOPMENT.md',
  'docs/TECHNICAL_PAPER.md',
  'docs/DEPENDENCY_POLICY.md',
  'docs/PRIVACY.md',
  'docs/THREAT_MODEL.md',
  'docs/SECURITY_AUDIT.md',
  'docs/THIRD_PARTY_NOTICES.md',
  'docs/MFA_TESTING.md',
  'docs/INSTALL_LOCAL.md',
  'docs/HOSTED_WEBAPP.md',
  'docs/RELEASE_TESTING.md',
  'LICENSE',
  '.dockerignore',
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'proxy.js',
  'proxy/app-state.js',
  'proxy/config.js',
  'proxy/fsd-proxy.js',
  'proxy/fsd-parser.js',
  'proxy/local-web-server.js',
  'proxy/ogg-speex.js',
  'proxy/pilot-bridge.js',
  'proxy/pilot-core.js',
  'proxy/port-diagnostics.js',
  'proxy/remote-agent.js',
  'proxy/socket-utils.js',
  'proxy/static-web.js',
  'proxy/ts2-voice-proxy.js',
  'proxy/web-tx.js',
  'proxy/websocket-commands.js',
  'apps/relay/index.js',
  'apps/relay/db.js',
  'apps/relay/legal.js',
  'apps/relay/retention.js',
  'apps/relay/admin.html',
  'apps/relay/admin.css',
  'apps/relay/admin.js',
  'apps/relay/admin-mfa.js',
  'apps/relay/migrations/001_initial_identity.sql',
  'apps/relay/migrations/002_account_passwords.sql',
  'apps/relay/migrations/003_admin_auth.sql',
  'apps/relay/migrations/004_admin_mfa.sql',
  'apps/relay/migrations/005_account_recovery.sql',
  'apps/relay/migrations/006_server_directory.sql',
  'apps/relay/migrations/007_legal_acceptance.sql',
  'apps/relay/README.md',
  'apps/relay/.env.example',
  'infra/docker/relay.Dockerfile',
  'infra/docker/docker-compose.yml',
  'infra/docker/Caddyfile',
  'infra/docker/.env.example',
  'infra/docker/defaults.env',
  'infra/docker/voxhf-server.sh',
  'packages/protocol/index.js',
  'packages/protocol/README.md',
  'scripts/env-file.js',
  'scripts/setup.js',
  'scripts/test-setup.js',
  'scripts/run-relay.js',
  'scripts/relay-user.js',
  'scripts/import-relay-users.js',
  'scripts/prepare-release.js',
  'scripts/verify-release.js',
  'scripts/check-release-version.js',
  'scripts/set-release-version.js',
  'scripts/update-local.js',
  'scripts/test-local-update.js',
  'scripts/relay-db-user.js',
  'scripts/relay-backup.js',
  'scripts/test-relay-backup.js',
  'scripts/test-relay-db.js',
  'scripts/test-relay-db-auth.js',
  'scripts/test-relay-db-user.js',
  'scripts/test-relay-admin.js',
  'scripts/test-relay-account.js',
  'scripts/check-admin-mfa-live.js',
  'scripts/check-remote-preview.js',
  'scripts/test-remote-preview.js',
  'scripts/directory-server.js',
  'scripts/test-directory.js',
  'scripts/test-directory-api.js',
  'scripts/preview-site.js',
  'webapp/index.html',
  'webapp/setup.html',
  'webapp/servers.html',
  'webapp/privacy.html',
  'webapp/terms.html',
  'webapp/login.html',
  'webapp/app.html',
  'webapp/entry.css',
  'webapp/site.css',
  'webapp/landing.css',
  'webapp/setup.css',
  'webapp/site.js',
  'webapp/servers.js',
  'webapp/auth.js',
  'webapp/styles.css',
  'webapp/app.js',
  'webapp/release.json',
  'docs/ADMIN_REDESIGN.md',
  'config.example.json',
  'release-manifest.json',
  'package.json',
  'package-lock.json',
];

let failures = 0;

function check(label, fn) {
  // Keep running after failures so one command reports the full checklist.
  try {
    fn();
    console.log(`[OK] ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`[FAIL] ${label}`);
    console.error(`       ${err.message}`);
  }
}

function filePath(relativePath) {
  // Use repository-relative paths everywhere to keep error messages readable.
  return path.join(root, relativePath);
}

function requireFile(relativePath) {
  // Existence is enough here; content-specific checks happen in the dedicated
  // JSON/syntax steps below.
  if (!fs.existsSync(filePath(relativePath))) {
    throw new Error(`${relativePath} is missing`);
  }
}

function parseJson(relativePath) {
  // JSON.parse catches broken package/config files before users hit runtime.
  return JSON.parse(fs.readFileSync(filePath(relativePath), 'utf8'));
}

function checkNodeSyntax(relativePath) {
  // node --check parses the file without executing the proxy or opening ports.
  const result = spawnSync(process.execPath, ['--check', filePath(relativePath)], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'node --check failed').trim());
  }
}

function runNodeScript(relativePath) {
  // Some checks need to execute a tiny isolated script, for example database
  // migrations against a temporary file.
  const result = spawnSync(process.execPath, [filePath(relativePath)], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'node script failed').trim());
  }
}

function checkWebappReferences() {
  const landing = fs.readFileSync(filePath('webapp/index.html'), 'utf8');
  const setup = fs.readFileSync(filePath('webapp/setup.html'), 'utf8');
  const servers = fs.readFileSync(filePath('webapp/servers.html'), 'utf8');
  const privacy = fs.readFileSync(filePath('webapp/privacy.html'), 'utf8');
  const terms = fs.readFileSync(filePath('webapp/terms.html'), 'utf8');
  const login = fs.readFileSync(filePath('webapp/login.html'), 'utf8');
  const app = fs.readFileSync(filePath('webapp/app.html'), 'utf8');
  if (!landing.includes('href="site.css"') || !landing.includes('href="landing.css"')
      || !landing.includes('src="site.js"')) {
    throw new Error('landing page assets are not linked');
  }
  const landingScreenshots = [
    'hero-workspace.png',
    'feature-radio-xpdr.png',
    'feature-voice.png',
    'feature-messages.png',
    'feature-weather.png',
  ];
  const carouselDots = (landing.match(/data-carousel-dot=/g) || []).length;
  const screenshotsReady = landingScreenshots.every(name => {
    const relativePath = `webapp/assets/screenshots/${name}`;
    return landing.includes(`assets/screenshots/${name}`) && fs.existsSync(filePath(relativePath));
  });
  if (!screenshotsReady || carouselDots !== 4) {
    throw new Error('landing screenshots or carousel controls are incomplete');
  }
  if (!setup.includes('href="site.css"') || !setup.includes('href="setup.css"')
      || !setup.includes('src="site.js"')) {
    throw new Error('setup page assets are not linked');
  }
  if (!servers.includes('href="site.css"') || !servers.includes('src="servers.js"')) {
    throw new Error('server directory assets are not linked');
  }
  if (!landing.includes('href="privacy.html"') || !landing.includes('href="terms.html"')
      || !privacy.includes('href="site.css"') || !terms.includes('href="site.css"')) {
    throw new Error('public legal pages are not linked');
  }
  for (const marker of ['Daniele De Stefano', 'legal@voxhf.com', 'Hetzner Online GmbH']) {
    if (privacy.includes(marker) || terms.includes(marker) || login.includes(marker)) {
      throw new Error(`deployment-specific legal data entered public webapp files: ${marker}`);
    }
  }
  if (!privacy.includes('Self-host template') || !terms.includes('Self-host template')) {
    throw new Error('public legal pages must remain neutral self-host templates');
  }
  if (!login.includes('href="entry.css"') || !login.includes('src="auth.js"')
      || !login.includes('href="/terms"') || !login.includes('href="/privacy"')) {
    throw new Error('login page assets are not linked');
  }
  if (!app.includes('href="styles.css"') || !app.includes('src="app.js"')) {
    throw new Error('workspace assets are not linked');
  }
}

function checkAdminReferences() {
  const html = fs.readFileSync(filePath('apps/relay/admin.html'), 'utf8');
  if (!html.includes('href="/admin/admin.css"')
      || !html.includes('src="/admin/webauthn.js"')
      || !html.includes('src="/admin/admin.js"')) {
    throw new Error('relay admin assets are not linked');
  }
  if (/<script(?![^>]+src=)[^>]*>/i.test(html)) {
    throw new Error('relay admin must not contain inline scripts');
  }
}

function checkRemoteProtocol() {
  // The remote protocol is security-sensitive: the relay must start from an
  // allowlist and reject unknown/raw command shapes by default.
  const protocol = require(filePath('packages/protocol'));
  const validRadio = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' }, 'check-radio'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!validRadio.ok) throw new Error(`valid radio message rejected: ${validRadio.error}`);

  const invalidRadioFrequency = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '199.999' }, 'check-radio-range'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (invalidRadioFrequency.ok) throw new Error('out-of-range radio frequency accepted');

  const wrongSource = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' }, 'check-source'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (wrongSource.ok) throw new Error('radio.set accepted from agent source');

  const unknown = protocol.validateRemoteMessage(
    { v: protocol.REMOTE_PROTOCOL_VERSION, id: 'check-raw', type: 'fsd.raw', payload: { line: '$CQ...' } },
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (unknown.ok) throw new Error('unknown raw message type accepted');

  const agentHello = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_HELLO, { deviceName: 'Home PC' }, 'check-agent'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!agentHello.ok) throw new Error(`valid agent hello rejected: ${agentHello.error}`);

  const deviceSelect = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.DEVICE_SELECT, { deviceId: 'dev-12345678' }, 'check-select'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!deviceSelect.ok) throw new Error(`valid device select rejected: ${deviceSelect.error}`);

  const pairingCode = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_CODE, { code: 'ABC-123', expiresAt: '2026-01-01T00:00:00.000Z' }, 'check-pair-code'),
    { source: protocol.MESSAGE_SOURCES.RELAY }
  );
  if (!pairingCode.ok) throw new Error(`valid pairing.code rejected: ${pairingCode.error}`);

  const pairingConfirm = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_CONFIRM, { code: 'ABC-123' }, 'check-pair-confirm'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!pairingConfirm.ok) throw new Error(`valid pairing.confirm rejected: ${pairingConfirm.error}`);

  const pairingRevoke = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_REVOKE, { deviceId: 'dev-12345678' }, 'check-pair-revoke'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!pairingRevoke.ok) throw new Error(`valid pairing.revoke rejected: ${pairingRevoke.error}`);

  const pairingRevoked = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_REVOKED, { deviceId: 'dev-12345678' }, 'check-pair-revoked'),
    { source: protocol.MESSAGE_SOURCES.RELAY }
  );
  if (!pairingRevoked.ok) throw new Error(`valid pairing.revoked rejected: ${pairingRevoked.error}`);

  const txStart = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.TX_START, { com: 1 }, 'check-tx-start'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!txStart.ok) throw new Error(`valid tx.start rejected: ${txStart.error}`);

  const weatherRequest = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.WEATHER_REQUEST, { kind: 'metar', icao: 'LIMC', source: 'panel', role: 'departure' }, 'check-weather'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!weatherRequest.ok) throw new Error(`valid weather.request rejected: ${weatherRequest.error}`);

  const atisRequest = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.ATIS_REQUEST, { callsign: 'LIMC_TWR' }, 'check-atis'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!atisRequest.ok) throw new Error(`valid atis.request rejected: ${atisRequest.error}`);

  const agentStatus = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_STATUS, {
      connected: true,
      callsign: 'MHL212',
      squawk: '2000',
      xpdrMode: 'alt',
    }, 'check-status'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!agentStatus.ok) throw new Error(`valid agent.status rejected: ${agentStatus.error}`);

  const stationsState = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.STATIONS_STATE, {
      stations: [{ callsign: 'LIMC_TWR', freq: '118.100', lat: 45.63, lon: 8.72 }],
      ownPosition: { lat: 45.50, lon: 8.80 },
    }, 'check-stations'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!stationsState.ok) throw new Error(`valid stations.state rejected: ${stationsState.error}`);

  const forgedAgentStatus = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_STATUS, { connected: true }, 'check-forged-status'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (forgedAgentStatus.ok) throw new Error('agent.status accepted from browser source');
  if (protocol.compareVersions('0.1.1', '0.1.0') <= 0) throw new Error('newer version comparison failed');
  if (protocol.compareVersions('0.1.0-alpha.1', '0.1.0') >= 0) throw new Error('prerelease comparison failed');
  if (protocol.compareVersions('v1.0.0', '1.0.0') !== 0) throw new Error('version normalization failed');
}

function checkProxyPrivacyGuards() {
  // FSD lines can contain chat text and protocol details. The proxy may parse
  // them internally, but the console and browser history should receive typed
  // summaries instead of raw lines.
  for (const relativePath of ['proxy.js', 'proxy/fsd-proxy.js']) {
    const source = fs.readFileSync(filePath(relativePath), 'utf8');
    if (/console\.log\([^)]*line\.trim\(\)/.test(source)) {
      throw new Error(`${relativePath} logs raw FSD lines to the console`);
    }
    if (/\bbroadcast\(msg\)/.test(source) || /\bstate\.broadcast\(msg\)/.test(source)) {
      throw new Error(`${relativePath} broadcasts raw parsed FSD events without stripping raw`);
    }
  }
}

function checkHostedSecurityGuards() {
  const relay = fs.readFileSync(filePath('apps/relay/index.js'), 'utf8');
  const caddy = fs.readFileSync(filePath('infra/docker/Caddyfile'), 'utf8');
  const compose = fs.readFileSync(filePath('infra/docker/docker-compose.yml'), 'utf8');
  const packager = fs.readFileSync(filePath('scripts/prepare-release.js'), 'utf8');
  const workspace = fs.readFileSync(filePath('webapp/app.html'), 'utf8');

  for (const guard of ['validateApiRequest(req)', 'allowHttpAttempt(req, res', "'retry-after'"]) {
    if (!relay.includes(guard)) throw new Error(`relay HTTP guard is missing: ${guard}`);
  }
  for (const header of ['Strict-Transport-Security', 'Content-Security-Policy', 'Permissions-Policy', 'X-Frame-Options']) {
    if (!caddy.includes(header)) throw new Error(`hosted security header is missing: ${header}`);
  }
  if (/<script>([\s\S]*?)<\/script>/.test(workspace)) {
    throw new Error('workspace contains an inline script that conflicts with its CSP');
  }
  for (const variable of ['VOXHF_LEGAL_PRIVACY_FILE', 'VOXHF_LEGAL_TERMS_FILE']) {
    if (!compose.includes(variable)) throw new Error(`legal overlay mount is missing: ${variable}`);
  }
  if (!packager.includes("'private'")) {
    throw new Error('release packager no longer excludes private deployment files');
  }
}

function checkDependencyLicenses() {
  // This is intentionally conservative and dependency-light. It catches obvious
  // policy violations while THIRD_PARTY_NOTICES.md remains the human-readable
  // source of truth for reviewed direct dependencies.
  const lock = JSON.parse(fs.readFileSync(filePath('package-lock.json'), 'utf8'));
  const allowed = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense'];
  const blocked = ['GPL', 'AGPL', 'SSPL', 'Commons Clause', 'Business Source License'];

  for (const [name, meta] of Object.entries(lock.packages || {})) {
    if (!name || !name.startsWith('node_modules/')) continue;
    const license = String(meta.license || '').trim();
    if (!license) throw new Error(`${name} has no license in package-lock.json`);
    if (blocked.some((item) => license.includes(item))) {
      throw new Error(`${name} uses blocked license expression: ${license}`);
    }
    if (!allowed.some((item) => license.includes(item))) {
      throw new Error(`${name} uses unreviewed license expression: ${license}`);
    }
  }
}

// The checks below are ordered from structural to behavioral so early output is
// easy to scan when a fresh checkout is incomplete.
check('required files', () => requiredFiles.forEach(requireFile));
check('proxy.js syntax', () => checkNodeSyntax('proxy.js'));
check('proxy app state syntax', () => checkNodeSyntax('proxy/app-state.js'));
check('proxy config syntax', () => checkNodeSyntax('proxy/config.js'));
check('proxy FSD proxy syntax', () => checkNodeSyntax('proxy/fsd-proxy.js'));
check('proxy fsd parser syntax', () => checkNodeSyntax('proxy/fsd-parser.js'));
check('proxy local web server syntax', () => checkNodeSyntax('proxy/local-web-server.js'));
check('proxy ogg-speex syntax', () => checkNodeSyntax('proxy/ogg-speex.js'));
check('proxy pilot bridge syntax', () => checkNodeSyntax('proxy/pilot-bridge.js'));
check('proxy pilot core syntax', () => checkNodeSyntax('proxy/pilot-core.js'));
check('proxy port diagnostics syntax', () => checkNodeSyntax('proxy/port-diagnostics.js'));
check('proxy remote agent syntax', () => checkNodeSyntax('proxy/remote-agent.js'));
check('proxy socket utils syntax', () => checkNodeSyntax('proxy/socket-utils.js'));
check('proxy static web syntax', () => checkNodeSyntax('proxy/static-web.js'));
check('proxy TS2 voice proxy syntax', () => checkNodeSyntax('proxy/ts2-voice-proxy.js'));
check('proxy web tx syntax', () => checkNodeSyntax('proxy/web-tx.js'));
check('proxy websocket commands syntax', () => checkNodeSyntax('proxy/websocket-commands.js'));
check('relay syntax', () => checkNodeSyntax('apps/relay/index.js'));
check('relay db syntax', () => checkNodeSyntax('apps/relay/db.js'));
check('relay legal configuration syntax', () => checkNodeSyntax('apps/relay/legal.js'));
check('relay retention syntax', () => checkNodeSyntax('apps/relay/retention.js'));
check('relay runner syntax', () => checkNodeSyntax('scripts/run-relay.js'));
check('setup wizard syntax', () => checkNodeSyntax('scripts/setup.js'));
check('setup wizard tests syntax', () => checkNodeSyntax('scripts/test-setup.js'));
check('relay user helper syntax', () => checkNodeSyntax('scripts/relay-user.js'));
check('relay user import syntax', () => checkNodeSyntax('scripts/import-relay-users.js'));
check('release packager syntax', () => checkNodeSyntax('scripts/prepare-release.js'));
check('release verifier syntax', () => checkNodeSyntax('scripts/verify-release.js'));
check('release version check syntax', () => checkNodeSyntax('scripts/check-release-version.js'));
check('release version setter syntax', () => checkNodeSyntax('scripts/set-release-version.js'));
check('local updater syntax', () => checkNodeSyntax('scripts/update-local.js'));
check('local updater test syntax', () => checkNodeSyntax('scripts/test-local-update.js'));
check('relay database user helper syntax', () => checkNodeSyntax('scripts/relay-db-user.js'));
check('relay backup syntax', () => checkNodeSyntax('scripts/relay-backup.js'));
check('relay backup test syntax', () => checkNodeSyntax('scripts/test-relay-backup.js'));
check('relay db migration syntax', () => checkNodeSyntax('scripts/test-relay-db.js'));
check('relay db auth syntax', () => checkNodeSyntax('scripts/test-relay-db-auth.js'));
check('relay db user test syntax', () => checkNodeSyntax('scripts/test-relay-db-user.js'));
check('relay admin test syntax', () => checkNodeSyntax('scripts/test-relay-admin.js'));
check('relay account test syntax', () => checkNodeSyntax('scripts/test-relay-account.js'));
check('directory helper syntax', () => checkNodeSyntax('scripts/directory-server.js'));
check('directory test syntax', () => checkNodeSyntax('scripts/test-directory.js'));
check('directory API test syntax', () => checkNodeSyntax('scripts/test-directory-api.js'));
check('site preview syntax', () => checkNodeSyntax('scripts/preview-site.js'));
check('relay MFA preflight syntax', () => checkNodeSyntax('scripts/check-admin-mfa-live.js'));
check('remote preflight syntax', () => checkNodeSyntax('scripts/check-remote-preview.js'));
check('remote simulation syntax', () => checkNodeSyntax('scripts/test-remote-preview.js'));
check('remote protocol syntax', () => checkNodeSyntax('packages/protocol/index.js'));
check('remote protocol rules', checkRemoteProtocol);
check('relay database migrations', () => runNodeScript('scripts/test-relay-db.js'));
check('setup configuration generation', () => runNodeScript('scripts/test-setup.js'));
check('relay database auth', () => runNodeScript('scripts/test-relay-db-auth.js'));
check('relay database user helper', () => runNodeScript('scripts/test-relay-db-user.js'));
check('relay backup and restore', () => runNodeScript('scripts/test-relay-backup.js'));
check('relay admin api', () => runNodeScript('scripts/test-relay-admin.js'));
check('relay account api', () => runNodeScript('scripts/test-relay-account.js'));
check('public directory registry', () => runNodeScript('scripts/test-directory.js'));
check('public directory HTTP API', () => runNodeScript('scripts/test-directory-api.js'));
check('proxy privacy guards', checkProxyPrivacyGuards);
check('hosted security guards', checkHostedSecurityGuards);
check('dependency licenses', checkDependencyLicenses);
check('webapp asset references', checkWebappReferences);
check('webapp script syntax', () => checkNodeSyntax('webapp/app.js'));
check('account script syntax', () => checkNodeSyntax('webapp/auth.js'));
check('public site script syntax', () => checkNodeSyntax('webapp/site.js'));
check('server directory script syntax', () => checkNodeSyntax('webapp/servers.js'));
check('relay admin asset references', checkAdminReferences);
check('relay admin script syntax', () => checkNodeSyntax('apps/relay/admin.js'));
check('relay admin MFA syntax', () => checkNodeSyntax('apps/relay/admin-mfa.js'));
check('package.json', () => parseJson('package.json'));
check('package-lock.json', () => parseJson('package-lock.json'));
check('project license', () => {
  const packageJson = parseJson('package.json');
  const packageLock = parseJson('package-lock.json');
  if (packageJson.license !== 'AGPL-3.0-only') throw new Error('package.json must use AGPL-3.0-only');
  if (packageLock.packages?.['']?.license !== 'AGPL-3.0-only') throw new Error('package-lock.json must use AGPL-3.0-only');
  const license = fs.readFileSync(filePath('LICENSE'), 'utf8');
  if (!license.includes('GNU AFFERO GENERAL PUBLIC LICENSE') || !license.includes('Version 3, 19 November 2007')) {
    throw new Error('LICENSE must contain the GNU Affero General Public License v3 text');
  }
});
check('config.example.json', () => parseJson('config.example.json'));
check('release-manifest.json', () => parseJson('release-manifest.json'));
check('webapp/release.json', () => parseJson('webapp/release.json'));

if (fs.existsSync(filePath('config.json'))) {
  check('config.json', () => parseJson('config.json'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll checks passed.');
