'use strict';

// SQLite support for the relay dashboard/control-plane database.
//
// This module is intentionally small and synchronous. Relay database writes are
// low-frequency admin/control events, while live audio and WebSocket routing
// stay in memory and never touch SQLite.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openRelayDatabase(options = {}) {
  const filename = path.resolve(options.filename || defaultDatabasePath());
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  const db = new Database(filename);
  configureDatabase(db);
  applyMigrations(db, options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  return db;
}

function defaultDatabasePath(env = process.env) {
  const configured = String(env.VOXHF_RELAY_DATABASE || '').trim();
  if (configured) return configured;

  const dataDir = String(env.VOXHF_RELAY_DATA_DIR || '.voxhf-relay').trim();
  return path.join(dataDir || '.voxhf-relay', 'voxhf.db');
}

function configureDatabase(db) {
  // WAL keeps readers responsive while occasional admin writes happen. Foreign
  // keys are off by default in SQLite, so every connection must enable them.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

function applyMigrations(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = listMigrations(migrationsDir);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    runMigration(db, migration);
    applied.add(migration.version);
  }
}

function listMigrations(migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .map((file) => {
      const match = file.match(/^(\d+)_([A-Za-z0-9_-]+)\.sql$/);
      if (!match) return null;
      return {
        version: Number(match[1]),
        name: match[2],
        file,
        path: path.join(migrationsDir, file),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);

  for (let index = 1; index < files.length; index += 1) {
    if (files[index].version === files[index - 1].version) {
      throw new Error(`Duplicate migration version: ${files[index].version}`);
    }
  }

  return files;
}

function runMigration(db, migration) {
  const sql = fs.readFileSync(migration.path, 'utf8');
  const apply = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
      .run(migration.version, migration.name);
  });
  apply();
}

function importRelayUserToken(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const displayName = requireDbText(input.displayName || input.userId, 'displayName');
  const token = requireDbText(input.token, 'token');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const dbUserId = relayUserDbId(userId);

  const importToken = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, username, display_name, created_at)
      VALUES (@id, @username, @displayName, @now)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        disabled_at = NULL
    `).run({
      id: dbUserId,
      username: userId,
      displayName,
      now,
    });

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(userId);
    const existing = db.prepare(`
      SELECT id, token_hash
      FROM agent_tokens
      WHERE user_id = ? AND name = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
    `).all(user.id, input.tokenName || 'Relay preview token');

    if (existing.some((row) => row.token_hash === tokenHash)) {
      return { action: 'unchanged', userId, tokenPrefix: tokenPrefix(token) };
    }

    db.prepare(`
      UPDATE agent_tokens
      SET revoked_at = @now
      WHERE user_id = @userId AND name = @name AND revoked_at IS NULL
    `).run({
      now,
      userId: user.id,
      name: input.tokenName || 'Relay preview token',
    });

    db.prepare(`
      INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash, created_at)
      VALUES (@id, @userId, @name, @tokenPrefix, @tokenHash, @now)
    `).run({
      id: `tok_${crypto.randomUUID()}`,
      userId: user.id,
      name: input.tokenName || 'Relay preview token',
      tokenPrefix: tokenPrefix(token),
      tokenHash,
      now,
    });

    return {
      action: existing.length ? 'rotated' : 'created',
      userId,
      tokenPrefix: tokenPrefix(token),
    };
  });

  return importToken();
}

function createRelayAccount(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const displayName = requireDbText(input.displayName || input.userId, 'displayName');
  const passwordHash = requireDbText(input.passwordHash, 'passwordHash');
  const token = requireDbText(input.token, 'token');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const termsVersion = requireDbText(input.termsVersion, 'termsVersion');
  const privacyVersion = requireDbText(input.privacyVersion, 'privacyVersion');
  const legalAcceptanceMethod = requireDbText(input.legalAcceptanceMethod, 'legalAcceptanceMethod');
  const dbUserId = relayUserDbId(userId);

  const createAccount = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(userId);
    if (existing) throw new Error('user already exists');

    db.prepare(`
      INSERT INTO users (
        id, username, display_name, password_hash, created_at,
        terms_version, privacy_version, legal_accepted_at, legal_acceptance_method
      ) VALUES (
        @id, @username, @displayName, @passwordHash, @now,
        @termsVersion, @privacyVersion, @now, @legalAcceptanceMethod
      )
    `).run({
      id: dbUserId,
      username: userId,
      displayName,
      passwordHash,
      now,
      termsVersion,
      privacyVersion,
      legalAcceptanceMethod,
    });

    db.prepare(`
      INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash, created_at)
      VALUES (@id, @userId, @name, @tokenPrefix, @tokenHash, @now)
    `).run({
      id: `tok_${crypto.randomUUID()}`,
      userId: dbUserId,
      name: input.tokenName || 'Relay preview token',
      tokenPrefix: tokenPrefix(token),
      tokenHash,
      now,
    });

    return {
      userId,
      displayName,
      tokenPrefix: tokenPrefix(token),
    };
  });

  return createAccount();
}

function listImportedRelayUsers(db) {
  return db.prepare(`
    SELECT
      users.username,
      users.display_name AS displayName,
      agent_tokens.name AS tokenName,
      agent_tokens.token_prefix AS tokenPrefix,
      agent_tokens.created_at AS createdAt,
      agent_tokens.revoked_at AS revokedAt
    FROM users
    LEFT JOIN agent_tokens ON agent_tokens.user_id = users.id
    ORDER BY users.username, agent_tokens.created_at
  `).all();
}

function listRelayUserSummaries(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS displayName,
      users.created_at AS createdAt,
      users.disabled_at AS disabledAt,
      COUNT(agent_tokens.id) AS tokenCount,
      SUM(CASE WHEN agent_tokens.id IS NOT NULL AND agent_tokens.revoked_at IS NULL THEN 1 ELSE 0 END) AS activeTokenCount,
      GROUP_CONCAT(CASE WHEN agent_tokens.revoked_at IS NULL THEN agent_tokens.token_prefix END, ',') AS activeTokenPrefixes
    FROM users
    LEFT JOIN agent_tokens ON agent_tokens.user_id = users.id
    GROUP BY users.id
    ORDER BY users.username
  `).all();
}

function listActiveRelayTokenUsers(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS userName,
      agent_tokens.token_hash AS tokenHash
    FROM users
    JOIN agent_tokens ON agent_tokens.user_id = users.id
    WHERE users.disabled_at IS NULL
      AND agent_tokens.revoked_at IS NULL
    ORDER BY users.username, agent_tokens.created_at
  `).all();
}

function upsertRelayAgent(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const name = requireDbText(input.name || input.deviceName || deviceId, 'deviceName');
  const now = new Date().toISOString();
  const user = ensureRelayUser(db, userId, input.userName || userId);
  const agentId = relayAgentDbId(user.id, deviceId);

  db.prepare(`
    INSERT INTO agents (id, user_id, token_id, device_id, name, first_seen_at, last_seen_at)
    VALUES (@id, @userId, NULL, @deviceId, @name, @now, @now)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      name = excluded.name,
      last_seen_at = excluded.last_seen_at,
      disabled_at = NULL
  `).run({
    id: agentId,
    userId: user.id,
    deviceId,
    name,
    now,
  });

  return {
    agentId,
    userId,
    deviceId,
    name,
  };
}

function upsertBrowserPairing(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const browserId = requireDbText(input.browserId, 'browserId');
  const browserLabel = String(input.browserLabel || '').trim() || null;
  const now = new Date().toISOString();
  const agent = upsertRelayAgent(db, input);
  const user = requireRelayUser(db, userId);
  const browserIdHash = hashBrowserForUser(userId, browserId);

  db.prepare(`
    INSERT INTO browser_pairings (
      id,
      user_id,
      agent_id,
      browser_id_hash,
      browser_label,
      created_at,
      last_used_at
    )
    VALUES (@id, @userId, @agentId, @browserIdHash, @browserLabel, @now, @now)
    ON CONFLICT(user_id, agent_id, browser_id_hash) DO UPDATE SET
      browser_label = COALESCE(excluded.browser_label, browser_pairings.browser_label),
      last_used_at = excluded.last_used_at,
      revoked_at = NULL
  `).run({
    id: `pair_${crypto.randomUUID()}`,
    userId: user.id,
    agentId: agent.agentId,
    browserIdHash,
    browserLabel,
    now,
  });

  return {
    userId,
    deviceId,
    browserIdHash,
  };
}

function revokeBrowserPairing(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const browserId = requireDbText(input.browserId, 'browserId');
  const user = requireRelayUser(db, userId);
  const agent = getRelayAgent(db, user.id, deviceId);
  if (!agent) return { userId, deviceId, browserIdHash: hashBrowserForUser(userId, browserId), count: 0 };

  const browserIdHash = hashBrowserForUser(userId, browserId);
  const result = db.prepare(`
    UPDATE browser_pairings
    SET revoked_at = @now
    WHERE user_id = @userId
      AND agent_id = @agentId
      AND browser_id_hash = @browserIdHash
      AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    userId: user.id,
    agentId: agent.id,
    browserIdHash,
  });

  return { userId, deviceId, browserIdHash, count: result.changes };
}

function revokeBrowserPairingById(db, pairingId) {
  const pairing = getBrowserPairingById(db, pairingId);
  if (!pairing) return null;

  const result = db.prepare(`
    UPDATE browser_pairings
    SET revoked_at = @now
    WHERE id = @pairingId AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    pairingId,
  });

  return {
    ...pairing,
    count: result.changes,
  };
}

function listActiveBrowserPairings(db) {
  return db.prepare(`
    SELECT
      browser_pairings.id AS pairingId,
      users.username AS userId,
      users.display_name AS displayName,
      agents.device_id AS deviceId,
      agents.name AS deviceName,
      browser_pairings.browser_id_hash AS browserIdHash,
      browser_pairings.browser_label AS browserLabel,
      browser_pairings.created_at AS createdAt,
      browser_pairings.last_used_at AS lastUsedAt
    FROM browser_pairings
    JOIN users ON users.id = browser_pairings.user_id
    JOIN agents ON agents.id = browser_pairings.agent_id
    WHERE users.disabled_at IS NULL
      AND agents.disabled_at IS NULL
      AND browser_pairings.revoked_at IS NULL
    ORDER BY users.username, agents.name, browser_pairings.last_used_at DESC
  `).all();
}

function listRelayAgentSummaries(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS displayName,
      agents.device_id AS deviceId,
      agents.name AS deviceName,
      agents.first_seen_at AS firstSeenAt,
      agents.last_seen_at AS lastSeenAt,
      agents.disabled_at AS disabledAt,
      COUNT(browser_pairings.id) AS activePairingCount
    FROM agents
    JOIN users ON users.id = agents.user_id
    LEFT JOIN browser_pairings
      ON browser_pairings.agent_id = agents.id
      AND browser_pairings.revoked_at IS NULL
    GROUP BY agents.id
    ORDER BY users.username, agents.name
  `).all();
}

function insertAuditEvent(db, input) {
  const eventType = requireDbText(input.eventType, 'eventType');
  const actorType = requireDbText(input.actorType, 'actorType');
  const user = input.userId ? getRelayUser(db, input.userId) : null;
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? JSON.stringify(input.metadata)
    : null;

  db.prepare(`
    INSERT INTO audit_events (
      id,
      user_id,
      actor_type,
      actor_id,
      event_type,
      ip_address,
      target_agent_id,
      target_browser_pairing_id,
      command_type,
      created_at,
      metadata_json
    )
    VALUES (
      @id,
      @userId,
      @actorType,
      @actorId,
      @eventType,
      @ipAddress,
      @targetAgentId,
      @targetBrowserPairingId,
      @commandType,
      @now,
      @metadataJson
    )
  `).run({
    id: `aud_${crypto.randomUUID()}`,
    userId: user?.id || null,
    actorType,
    actorId: optionalDbText(input.actorId),
    eventType,
    ipAddress: optionalDbText(input.ipAddress),
    targetAgentId: optionalDbText(input.targetAgentId),
    targetBrowserPairingId: optionalDbText(input.targetBrowserPairingId),
    commandType: optionalDbText(input.commandType),
    now: new Date().toISOString(),
    metadataJson: metadata,
  });
}

function listAuditEvents(db, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  return db.prepare(`
    SELECT
      audit_events.id AS auditId,
      users.username AS userId,
      audit_events.actor_type AS actorType,
      audit_events.actor_id AS actorId,
      audit_events.event_type AS eventType,
      audit_events.ip_address AS ipAddress,
      audit_events.target_agent_id AS targetAgentId,
      audit_events.target_browser_pairing_id AS targetBrowserPairingId,
      audit_events.command_type AS commandType,
      audit_events.created_at AS createdAt,
      audit_events.metadata_json AS metadataJson
    FROM audit_events
    LEFT JOIN users ON users.id = audit_events.user_id
    ORDER BY audit_events.created_at DESC
    LIMIT ?
  `).all(limit);
}

function getRelayUser(db, userId) {
  const username = requireDbText(userId, 'userId');
  return db.prepare(`
    SELECT id, username AS userId, display_name AS displayName, created_at AS createdAt, disabled_at AS disabledAt
    FROM users
    WHERE username = ?
  `).get(username) || null;
}

function getRelayUserCredentials(db, userId) {
  const username = requireDbText(userId, 'userId');
  return db.prepare(`
    SELECT
      id,
      username AS userId,
      display_name AS displayName,
      password_hash AS passwordHash,
      created_at AS createdAt,
      disabled_at AS disabledAt
    FROM users
    WHERE username = ?
  `).get(username) || null;
}

function ensureRelayUser(db, userId, displayName) {
  const username = requireDbText(userId, 'userId');
  const name = requireDbText(displayName || username, 'displayName');
  const dbUserId = relayUserDbId(username);

  db.prepare(`
    INSERT INTO users (id, username, display_name, created_at)
    VALUES (@id, @username, @displayName, @now)
    ON CONFLICT(username) DO NOTHING
  `).run({
    id: dbUserId,
    username,
    displayName: name,
    now: new Date().toISOString(),
  });

  return requireRelayUser(db, username);
}

function setRelayUserDisabled(db, userId, disabled) {
  const user = requireRelayUser(db, userId);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
    .run(disabled ? now : null, user.id);

  return {
    userId: user.userId,
    action: disabled ? 'disabled' : 'enabled',
  };
}

function revokeRelayUserTokens(db, input) {
  const user = requireRelayUser(db, input.userId);
  const tokenName = input.tokenName ? requireDbText(input.tokenName, 'tokenName') : null;
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE agent_tokens
    SET revoked_at = @now
    WHERE user_id = @userId
      AND revoked_at IS NULL
      AND (@tokenName IS NULL OR name = @tokenName)
  `).run({
    now,
    userId: user.id,
    tokenName,
  });

  return {
    userId: user.userId,
    action: 'revoked',
    count: result.changes,
  };
}

function deleteRelayUser(db, userId) {
  const user = requireRelayUser(db, userId);
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return {
    userId: user.userId,
    action: 'deleted',
    count: result.changes,
  };
}

function createBrowserSession(db, input) {
  const user = requireRelayUser(db, input.userId);
  const sessionToken = requireDbText(input.sessionToken, 'sessionToken');
  const expiresAt = requireDbText(input.expiresAt, 'expiresAt');
  const now = new Date().toISOString();
  const sessionHash = hashToken(sessionToken);
  const sessionId = `ses_${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO browser_sessions (
      id,
      user_id,
      session_hash,
      browser_id_hash,
      created_at,
      last_seen_at,
      expires_at,
      ip_address,
      user_agent
    )
    VALUES (
      @id,
      @userId,
      @sessionHash,
      @browserIdHash,
      @now,
      @now,
      @expiresAt,
      @ipAddress,
      @userAgent
    )
  `).run({
    id: sessionId,
    userId: user.id,
    sessionHash,
    browserIdHash: optionalDbText(input.browserIdHash),
    now,
    expiresAt,
    ipAddress: optionalDbText(input.ipAddress),
    userAgent: optionalDbText(input.userAgent),
  });

  return {
    sessionId,
    userId: user.userId,
    displayName: user.displayName,
    expiresAt,
  };
}

function getBrowserSession(db, sessionToken) {
  const token = requireDbText(sessionToken, 'sessionToken');
  const sessionHash = hashToken(token);
  const now = new Date().toISOString();
  const session = db.prepare(`
    SELECT
      browser_sessions.id AS sessionId,
      users.username AS userId,
      users.display_name AS displayName,
      browser_sessions.expires_at AS expiresAt
    FROM browser_sessions
    JOIN users ON users.id = browser_sessions.user_id
    WHERE browser_sessions.session_hash = ?
      AND browser_sessions.revoked_at IS NULL
      AND browser_sessions.expires_at > ?
      AND users.disabled_at IS NULL
  `).get(sessionHash, now) || null;

  if (!session) return null;
  db.prepare('UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?')
    .run(now, session.sessionId);
  return session;
}

function listBrowserSessions(db, userId) {
  const user = requireRelayUser(db, userId);
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT
      id AS sessionId,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      expires_at AS expiresAt,
      ip_address AS ipAddress,
      user_agent AS userAgent
    FROM browser_sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY last_seen_at DESC, created_at DESC
  `).all(user.id, now);
}

function revokeBrowserSession(db, sessionToken) {
  const token = requireDbText(sessionToken, 'sessionToken');
  const result = db.prepare(`
    UPDATE browser_sessions
    SET revoked_at = @now
    WHERE session_hash = @sessionHash AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    sessionHash: hashToken(token),
  });

  return { count: result.changes };
}

function revokeBrowserSessionById(db, userId, sessionId) {
  const user = requireRelayUser(db, userId);
  const id = requireDbText(sessionId, 'sessionId');
  const result = db.prepare(`
    UPDATE browser_sessions
    SET revoked_at = @now
    WHERE id = @sessionId AND user_id = @userId AND revoked_at IS NULL
  `).run({ now: new Date().toISOString(), sessionId: id, userId: user.id });
  return { count: result.changes };
}

function revokeOtherBrowserSessions(db, userId, currentSessionId) {
  const user = requireRelayUser(db, userId);
  const keepId = requireDbText(currentSessionId, 'currentSessionId');
  const rows = db.prepare(`
    SELECT id FROM browser_sessions
    WHERE user_id = ? AND id != ? AND revoked_at IS NULL
  `).all(user.id, keepId);
  if (!rows.length) return { count: 0, sessionIds: [] };
  const now = new Date().toISOString();
  const revoke = db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const transaction = db.transaction(() => rows.reduce((count, row) => count + revoke.run(now, row.id).changes, 0));
  return { count: transaction(), sessionIds: rows.map((row) => row.id) };
}

function revokeAllBrowserSessions(db, userId) {
  const user = requireRelayUser(db, userId);
  const rows = db.prepare(`
    SELECT id FROM browser_sessions WHERE user_id = ? AND revoked_at IS NULL
  `).all(user.id);
  const result = db.prepare(`
    UPDATE browser_sessions SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), user.id);
  return { count: result.changes, sessionIds: rows.map((row) => row.id) };
}

function setRelayUserPassword(db, userId, passwordHash) {
  const user = requireRelayUser(db, userId);
  const hash = requireDbText(passwordHash, 'passwordHash');
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  return { count: result.changes, userId: user.userId };
}

function createAccountRecoveryCode(db, input) {
  const user = requireRelayUser(db, input.userId);
  const codeHash = requireDbText(input.codeHash, 'codeHash');
  const expiresAt = requireDbText(input.expiresAt, 'expiresAt');
  const now = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM account_recovery_codes WHERE user_id = ?').run(user.id);
    db.prepare(`
      INSERT INTO account_recovery_codes (id, user_id, code_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`rec_${crypto.randomUUID()}`, user.id, codeHash, now, expiresAt);
  });
  replace();
  return { userId: user.userId, createdAt: now, expiresAt };
}

function consumeAccountRecoveryCode(db, input) {
  const user = requireRelayUser(db, input.userId);
  const codeHash = requireDbText(input.codeHash, 'codeHash');
  const now = new Date().toISOString();
  const consume = db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM account_recovery_codes
      WHERE user_id = ? AND code_hash = ? AND expires_at > ?
    `).get(user.id, codeHash, now);
    if (!row) return { count: 0 };
    return { count: db.prepare('DELETE FROM account_recovery_codes WHERE id = ?').run(row.id).changes };
  });
  return consume();
}

function purgeAccountRecoveryCodes(db, now = new Date().toISOString()) {
  return db.prepare('DELETE FROM account_recovery_codes WHERE expires_at <= ?').run(now).changes;
}

function purgeBrowserSessions(db, now = new Date().toISOString()) {
  return db.prepare(`
    DELETE FROM browser_sessions
    WHERE expires_at <= ? OR revoked_at IS NOT NULL
  `).run(now).changes;
}

function countAdminAccounts(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM admin_accounts').get().count;
}

function createAdminAccount(db, input) {
  const username = requireDbText(input.username, 'username').toLowerCase();
  const displayName = requireDbText(input.displayName || username, 'displayName');
  const passwordHash = requireDbText(input.passwordHash, 'passwordHash');
  const role = input.role === 'operator' ? 'operator' : 'owner';
  const now = new Date().toISOString();
  const adminId = `adm_${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO admin_accounts (
      id, username, display_name, password_hash, role, created_at, password_changed_at
    )
    VALUES (@id, @username, @displayName, @passwordHash, @role, @now, @now)
  `).run({
    id: adminId,
    username,
    displayName,
    passwordHash,
    role,
    now,
  });

  return { adminId, username, displayName, role, createdAt: now };
}

function getAdminAccountCredentials(db, username) {
  const value = requireDbText(username, 'username').toLowerCase();
  return db.prepare(`
    SELECT
      id AS adminId,
      username,
      display_name AS displayName,
      password_hash AS passwordHash,
      role,
      created_at AS createdAt,
      password_changed_at AS passwordChangedAt,
      last_login_at AS lastLoginAt,
      disabled_at AS disabledAt
    FROM admin_accounts
    WHERE username = ? COLLATE NOCASE
  `).get(value) || null;
}

function getAdminAccountCredentialsById(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  return db.prepare(`
    SELECT
      id AS adminId,
      username,
      display_name AS displayName,
      password_hash AS passwordHash,
      role,
      created_at AS createdAt,
      password_changed_at AS passwordChangedAt,
      last_login_at AS lastLoginAt,
      disabled_at AS disabledAt
    FROM admin_accounts
    WHERE id = ?
  `).get(id) || null;
}

function setAdminLastLogin(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  const now = new Date().toISOString();
  db.prepare('UPDATE admin_accounts SET last_login_at = ? WHERE id = ?').run(now, id);
  return now;
}

function setAdminPassword(db, adminId, passwordHash) {
  const id = requireDbText(adminId, 'adminId');
  const hash = requireDbText(passwordHash, 'passwordHash');
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE admin_accounts
    SET password_hash = ?, password_changed_at = ?
    WHERE id = ? AND disabled_at IS NULL
  `).run(hash, now, id);
  return { count: result.changes, passwordChangedAt: now };
}

function createAdminSession(db, input) {
  const adminId = requireDbText(input.adminId, 'adminId');
  const sessionToken = requireDbText(input.sessionToken, 'sessionToken');
  const expiresAt = requireDbText(input.expiresAt, 'expiresAt');
  const now = new Date().toISOString();
  const sessionId = `adms_${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO admin_sessions (
      id, admin_id, session_hash, created_at, last_seen_at, expires_at, ip_address, user_agent
    )
    VALUES (
      @id, @adminId, @sessionHash, @now, @now, @expiresAt, @ipAddress, @userAgent
    )
  `).run({
    id: sessionId,
    adminId,
    sessionHash: hashToken(sessionToken),
    now,
    expiresAt,
    ipAddress: optionalDbText(input.ipAddress),
    userAgent: optionalDbText(input.userAgent),
  });

  return { sessionId, adminId, createdAt: now, lastSeenAt: now, expiresAt };
}

function getAdminSession(db, sessionToken, options = {}) {
  const token = requireDbText(sessionToken, 'sessionToken');
  const now = new Date().toISOString();
  const idleTtlMs = Math.max(0, Number(options.idleTtlMs || 0));
  const idleCutoff = idleTtlMs
    ? new Date(Date.now() - idleTtlMs).toISOString()
    : '1970-01-01T00:00:00.000Z';
  const session = db.prepare(`
    SELECT
      admin_sessions.id AS sessionId,
      admin_accounts.id AS adminId,
      admin_accounts.username,
      admin_accounts.display_name AS displayName,
      admin_accounts.role,
      admin_sessions.created_at AS createdAt,
      admin_sessions.last_seen_at AS lastSeenAt,
      admin_sessions.expires_at AS expiresAt
    FROM admin_sessions
    JOIN admin_accounts ON admin_accounts.id = admin_sessions.admin_id
    WHERE admin_sessions.session_hash = ?
      AND admin_sessions.revoked_at IS NULL
      AND admin_sessions.expires_at > ?
      AND admin_sessions.last_seen_at > ?
      AND admin_accounts.disabled_at IS NULL
  `).get(hashToken(token), now, idleCutoff) || null;

  if (!session) return null;
  db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now, session.sessionId);
  session.lastSeenAt = now;
  return session;
}

function listAdminSessions(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT
      id AS sessionId,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      expires_at AS expiresAt,
      ip_address AS ipAddress,
      user_agent AS userAgent
    FROM admin_sessions
    WHERE admin_id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
    ORDER BY last_seen_at DESC
  `).all(id, now);
}

function revokeAdminSessionById(db, adminId, sessionId) {
  const ownerId = requireDbText(adminId, 'adminId');
  const id = requireDbText(sessionId, 'sessionId');
  const result = db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = @now
    WHERE id = @sessionId AND admin_id = @adminId AND revoked_at IS NULL
  `).run({ now: new Date().toISOString(), sessionId: id, adminId: ownerId });
  return { count: result.changes };
}

function revokeOtherAdminSessions(db, adminId, currentSessionId) {
  const ownerId = requireDbText(adminId, 'adminId');
  const keepId = requireDbText(currentSessionId, 'currentSessionId');
  const result = db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = @now
    WHERE admin_id = @adminId AND id != @keepId AND revoked_at IS NULL
  `).run({ now: new Date().toISOString(), adminId: ownerId, keepId });
  return { count: result.changes };
}

function revokeAllAdminSessions(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  const result = db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = @now
    WHERE admin_id = @adminId AND revoked_at IS NULL
  `).run({ now: new Date().toISOString(), adminId: id });
  return { count: result.changes };
}

function purgeAdminSessions(db, now = new Date().toISOString()) {
  return db.prepare(`
    DELETE FROM admin_sessions
    WHERE expires_at <= ? OR revoked_at IS NOT NULL
  `).run(now).changes;
}

function listAdminPasskeys(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  return db.prepare(`
    SELECT
      id AS credentialId,
      name,
      webauthn_user_id AS webauthnUserId,
      public_key AS publicKey,
      counter,
      transports,
      device_type AS deviceType,
      backed_up AS backedUp,
      created_at AS createdAt,
      last_used_at AS lastUsedAt
    FROM admin_passkeys
    WHERE admin_id = ?
    ORDER BY created_at ASC
  `).all(id).map((row) => ({ ...row, backedUp: Boolean(row.backedUp) }));
}

function getAdminPasskey(db, adminId, credentialId) {
  const id = requireDbText(adminId, 'adminId');
  const credential = requireDbText(credentialId, 'credentialId');
  const row = db.prepare(`
    SELECT
      id AS credentialId,
      name,
      webauthn_user_id AS webauthnUserId,
      public_key AS publicKey,
      counter,
      transports,
      device_type AS deviceType,
      backed_up AS backedUp,
      created_at AS createdAt,
      last_used_at AS lastUsedAt
    FROM admin_passkeys
    WHERE admin_id = ? AND id = ?
  `).get(id, credential) || null;
  return row ? { ...row, backedUp: Boolean(row.backedUp) } : null;
}

function createAdminPasskey(db, input) {
  const adminId = requireDbText(input.adminId, 'adminId');
  const credentialId = requireDbText(input.credentialId, 'credentialId');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO admin_passkeys (
      id, admin_id, name, webauthn_user_id, public_key, counter, transports,
      device_type, backed_up, created_at
    ) VALUES (
      @credentialId, @adminId, @name, @webauthnUserId, @publicKey, @counter,
      @transports, @deviceType, @backedUp, @now
    )
  `).run({
    credentialId,
    adminId,
    name: requireDbText(input.name, 'name'),
    webauthnUserId: requireDbText(input.webauthnUserId, 'webauthnUserId'),
    publicKey: Buffer.from(input.publicKey),
    counter: Number(input.counter || 0),
    transports: JSON.stringify(input.transports || []),
    deviceType: requireDbText(input.deviceType, 'deviceType'),
    backedUp: input.backedUp ? 1 : 0,
    now,
  });
  return { credentialId, adminId, createdAt: now };
}

function updateAdminPasskeyUsage(db, adminId, credentialId, input) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE admin_passkeys
    SET counter = @counter,
        device_type = COALESCE(@deviceType, device_type),
        backed_up = COALESCE(@backedUp, backed_up),
        last_used_at = @now
    WHERE admin_id = @adminId AND id = @credentialId
  `).run({
    adminId: requireDbText(adminId, 'adminId'),
    credentialId: requireDbText(credentialId, 'credentialId'),
    counter: Number(input.counter || 0),
    deviceType: optionalDbText(input.deviceType),
    backedUp: input.backedUp === undefined ? null : (input.backedUp ? 1 : 0),
    now,
  });
  return { count: result.changes, lastUsedAt: now };
}

function deleteAdminPasskey(db, adminId, credentialId) {
  const result = db.prepare(`
    DELETE FROM admin_passkeys WHERE admin_id = ? AND id = ?
  `).run(
    requireDbText(adminId, 'adminId'),
    requireDbText(credentialId, 'credentialId')
  );
  return { count: result.changes };
}

function createAdminMfaChallenge(db, input) {
  const now = new Date().toISOString();
  const challengeId = `mfac_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO admin_mfa_challenges (
      id, admin_id, flow_hash, purpose, challenge, origin, rp_id, session_id,
      created_at, expires_at
    ) VALUES (
      @id, @adminId, @flowHash, @purpose, @challenge, @origin, @rpId,
      @sessionId, @now, @expiresAt
    )
  `).run({
    id: challengeId,
    adminId: requireDbText(input.adminId, 'adminId'),
    flowHash: hashToken(requireDbText(input.flowToken, 'flowToken')),
    purpose: requireDbText(input.purpose, 'purpose'),
    challenge: requireDbText(input.challenge, 'challenge'),
    origin: requireDbText(input.origin, 'origin'),
    rpId: requireDbText(input.rpId, 'rpId'),
    sessionId: optionalDbText(input.sessionId),
    now,
    expiresAt: requireDbText(input.expiresAt, 'expiresAt'),
  });
  return { challengeId, createdAt: now, expiresAt: input.expiresAt };
}

function consumeAdminMfaChallenge(db, input) {
  const consume = db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM admin_mfa_challenges WHERE expires_at <= ?').run(now);
    const row = db.prepare(`
      SELECT
        id AS challengeId,
        admin_id AS adminId,
        purpose,
        challenge,
        origin,
        rp_id AS rpId,
        session_id AS sessionId,
        expires_at AS expiresAt
      FROM admin_mfa_challenges
      WHERE flow_hash = ? AND purpose = ? AND expires_at > ?
    `).get(
      hashToken(requireDbText(input.flowToken, 'flowToken')),
      requireDbText(input.purpose, 'purpose'),
      now
    ) || null;
    if (!row) return null;
    if (input.adminId && row.adminId !== input.adminId) return null;
    if (input.sessionId && row.sessionId !== input.sessionId) return null;
    db.prepare('DELETE FROM admin_mfa_challenges WHERE id = ?').run(row.challengeId);
    return row;
  });
  return consume();
}

function replaceAdminRecoveryCodes(db, adminId, codeHashes) {
  const id = requireDbText(adminId, 'adminId');
  const now = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO admin_recovery_codes (id, admin_id, code_hash, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const codeHash of codeHashes) {
      insert.run(`mfar_${crypto.randomUUID()}`, id, requireDbText(codeHash, 'codeHash'), now);
    }
  });
  replace();
  return { count: codeHashes.length, createdAt: now };
}

function consumeAdminRecoveryCode(db, adminId, codeHash) {
  const id = requireDbText(adminId, 'adminId');
  const hash = requireDbText(codeHash, 'codeHash');
  const consume = db.transaction(() => {
    const code = db.prepare(`
      SELECT id FROM admin_recovery_codes
      WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL
    `).get(id, hash);
    if (!code) return { count: 0 };
    return {
      count: db.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(new Date().toISOString(), code.id).changes,
    };
  });
  return consume();
}

function countAdminRecoveryCodes(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  return db.prepare(`
    SELECT COUNT(*) AS count FROM admin_recovery_codes
    WHERE admin_id = ? AND used_at IS NULL
  `).get(id).count;
}

function clearAdminMfa(db, adminId) {
  const id = requireDbText(adminId, 'adminId');
  const clear = db.transaction(() => {
    const passkeys = db.prepare('DELETE FROM admin_passkeys WHERE admin_id = ?').run(id).changes;
    const recoveryCodes = db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(id).changes;
    db.prepare('DELETE FROM admin_mfa_challenges WHERE admin_id = ?').run(id);
    return { passkeys, recoveryCodes };
  });
  return clear();
}

// Directory identity is written only by the central registry administrator.
// A listed relay receives a secret heartbeat token, but cannot change its
// public name, operator, URLs, official flag, or moderation state.
function createDirectoryServer(db, input) {
  const now = new Date().toISOString();
  const id = input.id || `dir_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO directory_servers (
      id, slug, name, operator_name, region, access_policy, app_url, relay_url,
      description, privacy_url, source_url, token_hash, official, enabled,
      maintenance, created_at, updated_at
    ) VALUES (
      @id, @slug, @name, @operator, @region, @access, @appUrl, @relayUrl,
      @description, @privacyUrl, @sourceUrl, @tokenHash, @official, 1,
      0, @now, @now
    )
  `).run({
    id,
    slug: requireDbText(input.slug, 'slug'),
    name: requireDbText(input.name, 'name'),
    operator: requireDbText(input.operator, 'operator'),
    region: optionalDbText(input.region),
    access: requireDbText(input.access, 'access'),
    appUrl: requireDbText(input.appUrl, 'appUrl'),
    relayUrl: optionalDbText(input.relayUrl),
    description: optionalDbText(input.description),
    privacyUrl: optionalDbText(input.privacyUrl),
    sourceUrl: optionalDbText(input.sourceUrl),
    tokenHash: requireDbText(input.tokenHash, 'tokenHash'),
    official: input.official ? 1 : 0,
    now,
  });
  return { id, slug: input.slug, createdAt: now };
}

function listDirectoryServers(db) {
  return db.prepare(`
    SELECT
      id, slug, name, operator_name AS operator, region,
      access_policy AS access, app_url AS appUrl, relay_url AS relayUrl,
      description, privacy_url AS privacyUrl, source_url AS sourceUrl,
      official, enabled, maintenance, version,
      registration_open AS registrationOpen,
      created_at AS createdAt, updated_at AS updatedAt,
      last_seen_at AS lastSeenAt
    FROM directory_servers
    ORDER BY official DESC, name COLLATE NOCASE
  `).all().map(normalizeDirectoryRow);
}

function listPublicDirectoryServers(db) {
  return db.prepare(`
    SELECT
      id, slug, name, operator_name AS operator, region,
      access_policy AS access, app_url AS appUrl, relay_url AS relayUrl,
      description, privacy_url AS privacyUrl, source_url AS sourceUrl,
      official, maintenance, version,
      registration_open AS registrationOpen,
      updated_at AS updatedAt, last_seen_at AS lastSeenAt
    FROM directory_servers
    WHERE enabled = 1
    ORDER BY official DESC, name COLLATE NOCASE
  `).all().map(normalizeDirectoryRow);
}

function updateDirectoryHeartbeat(db, input) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE directory_servers
    SET version = @version,
        registration_open = @registrationOpen,
        last_seen_at = @now,
        updated_at = @now
    WHERE token_hash = @tokenHash AND enabled = 1
  `).run({
    tokenHash: requireDbText(input.tokenHash, 'tokenHash'),
    version: optionalDbText(input.version),
    registrationOpen: input.registrationOpen ? 1 : 0,
    now,
  });
  return { count: result.changes, lastSeenAt: now };
}

function setDirectoryServerState(db, slug, input) {
  const fields = [];
  const values = { slug: requireDbText(slug, 'slug'), now: new Date().toISOString() };
  if (typeof input.enabled === 'boolean') {
    fields.push('enabled = @enabled');
    values.enabled = input.enabled ? 1 : 0;
  }
  if (typeof input.maintenance === 'boolean') {
    fields.push('maintenance = @maintenance');
    values.maintenance = input.maintenance ? 1 : 0;
  }
  if (!fields.length) throw new Error('directory server state is required');
  fields.push('updated_at = @now');
  const result = db.prepare(`UPDATE directory_servers SET ${fields.join(', ')} WHERE slug = @slug`).run(values);
  return { count: result.changes, slug: values.slug };
}

function rotateDirectoryServerToken(db, slug, tokenHash) {
  const value = requireDbText(slug, 'slug');
  const result = db.prepare(`
    UPDATE directory_servers
    SET token_hash = ?, last_seen_at = NULL, updated_at = ?
    WHERE slug = ?
  `).run(requireDbText(tokenHash, 'tokenHash'), new Date().toISOString(), value);
  return { count: result.changes, slug: value };
}

function deleteDirectoryServer(db, slug) {
  const value = requireDbText(slug, 'slug');
  return { count: db.prepare('DELETE FROM directory_servers WHERE slug = ?').run(value).changes, slug: value };
}

function normalizeDirectoryRow(row) {
  return {
    ...row,
    official: row.official === 1,
    enabled: row.enabled === undefined ? true : row.enabled === 1,
    maintenance: row.maintenance === 1,
    registrationOpen: row.registrationOpen === 1,
  };
}

function clearBrowserSessionMetadata(db) {
  return db.prepare(`
    UPDATE browser_sessions
    SET ip_address = NULL, user_agent = NULL
    WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL
  `).run().changes;
}

function clearAdminSessionMetadata(db) {
  return db.prepare(`
    UPDATE admin_sessions
    SET ip_address = NULL, user_agent = NULL
    WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL
  `).run().changes;
}

function purgeAuditEvents(db, before = '') {
  if (!before) return db.prepare('DELETE FROM audit_events').run().changes;
  return db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(before).changes;
}

function requireRelayUser(db, userId) {
  const user = getRelayUser(db, userId);
  if (!user) throw new Error(`Relay user not found: ${userId}`);
  return user;
}

function getRelayAgent(db, dbUserId, deviceId) {
  return db.prepare(`
    SELECT id, device_id AS deviceId, name
    FROM agents
    WHERE user_id = ? AND device_id = ?
  `).get(dbUserId, deviceId) || null;
}

function getBrowserPairingById(db, pairingId) {
  const id = requireDbText(pairingId, 'pairingId');
  return db.prepare(`
    SELECT
      browser_pairings.id AS pairingId,
      users.username AS userId,
      agents.device_id AS deviceId,
      browser_pairings.browser_id_hash AS browserIdHash
    FROM browser_pairings
    JOIN users ON users.id = browser_pairings.user_id
    JOIN agents ON agents.id = browser_pairings.agent_id
    WHERE browser_pairings.id = ?
  `).get(id) || null;
}

function relayUserDbId(userId) {
  return `usr_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

function relayAgentDbId(dbUserId, deviceId) {
  return `agt_${crypto.createHash('sha256').update(`${dbUserId}:${deviceId}`).digest('hex').slice(0, 24)}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashBrowserForUser(userId, browserId) {
  return hashToken(`${userId}:${browserId}`);
}

function tokenPrefix(token) {
  return String(token).slice(0, 8);
}

function requireDbText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalDbText(value) {
  const text = String(value || '').trim();
  return text || null;
}

module.exports = {
  openRelayDatabase,
  defaultDatabasePath,
  configureDatabase,
  applyMigrations,
  listMigrations,
  createRelayAccount,
  importRelayUserToken,
  listImportedRelayUsers,
  listRelayUserSummaries,
  listActiveRelayTokenUsers,
  upsertRelayAgent,
  upsertBrowserPairing,
  revokeBrowserPairing,
  revokeBrowserPairingById,
  listActiveBrowserPairings,
  listRelayAgentSummaries,
  insertAuditEvent,
  listAuditEvents,
  getRelayUser,
  getRelayUserCredentials,
  setRelayUserDisabled,
  revokeRelayUserTokens,
  deleteRelayUser,
  createBrowserSession,
  getBrowserSession,
  listBrowserSessions,
  revokeBrowserSession,
  revokeBrowserSessionById,
  revokeOtherBrowserSessions,
  revokeAllBrowserSessions,
  setRelayUserPassword,
  createAccountRecoveryCode,
  consumeAccountRecoveryCode,
  purgeAccountRecoveryCodes,
  purgeBrowserSessions,
  countAdminAccounts,
  createAdminAccount,
  getAdminAccountCredentials,
  getAdminAccountCredentialsById,
  setAdminLastLogin,
  setAdminPassword,
  createAdminSession,
  getAdminSession,
  listAdminSessions,
  revokeAdminSessionById,
  revokeOtherAdminSessions,
  revokeAllAdminSessions,
  purgeAdminSessions,
  listAdminPasskeys,
  getAdminPasskey,
  createAdminPasskey,
  updateAdminPasskeyUsage,
  deleteAdminPasskey,
  createAdminMfaChallenge,
  consumeAdminMfaChallenge,
  replaceAdminRecoveryCodes,
  consumeAdminRecoveryCode,
  countAdminRecoveryCodes,
  clearAdminMfa,
  createDirectoryServer,
  listDirectoryServers,
  listPublicDirectoryServers,
  updateDirectoryHeartbeat,
  setDirectoryServerState,
  rotateDirectoryServerToken,
  deleteDirectoryServer,
  clearBrowserSessionMetadata,
  clearAdminSessionMetadata,
  purgeAuditEvents,
  hashToken,
  hashBrowserForUser,
  tokenPrefix,
};
