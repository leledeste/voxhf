CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TEXT
);

CREATE INDEX idx_users_disabled_at ON users(disabled_at);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_agent_tokens_user_id ON agent_tokens(user_id);
CREATE INDEX idx_agent_tokens_revoked_at ON agent_tokens(revoked_at);
CREATE INDEX idx_agent_tokens_last_used_at ON agent_tokens(last_used_at);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  disabled_at TEXT,
  UNIQUE(user_id, device_id)
);

CREATE INDEX idx_agents_user_id ON agents(user_id);
CREATE INDEX idx_agents_last_seen_at ON agents(last_seen_at);
CREATE INDEX idx_agents_disabled_at ON agents(disabled_at);

CREATE TABLE browser_pairings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  browser_id_hash TEXT NOT NULL,
  browser_label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE(user_id, agent_id, browser_id_hash)
);

CREATE INDEX idx_browser_pairings_user_id ON browser_pairings(user_id);
CREATE INDEX idx_browser_pairings_agent_id ON browser_pairings(agent_id);
CREATE INDEX idx_browser_pairings_revoked_at ON browser_pairings(revoked_at);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  browser_id_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX idx_browser_sessions_user_id ON browser_sessions(user_id);
CREATE INDEX idx_browser_sessions_expires_at ON browser_sessions(expires_at);
CREATE INDEX idx_browser_sessions_revoked_at ON browser_sessions(revoked_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  target_agent_id TEXT,
  target_browser_pairing_id TEXT,
  command_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT
);

CREATE INDEX idx_audit_events_user_id ON audit_events(user_id);
CREATE INDEX idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX idx_audit_events_target_agent_id ON audit_events(target_agent_id);
CREATE INDEX idx_audit_events_command_type ON audit_events(command_type);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
