CREATE TABLE directory_servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  region TEXT,
  access_policy TEXT NOT NULL CHECK (access_policy IN ('open', 'invite', 'closed')),
  app_url TEXT NOT NULL,
  relay_url TEXT,
  description TEXT,
  privacy_url TEXT,
  source_url TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),
  version TEXT,
  registration_open INTEGER NOT NULL DEFAULT 0 CHECK (registration_open IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX idx_directory_servers_public_order
  ON directory_servers(enabled, official DESC, name);
CREATE INDEX idx_directory_servers_last_seen
  ON directory_servers(last_seen_at);
