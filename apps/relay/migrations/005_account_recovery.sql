CREATE TABLE account_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_account_recovery_codes_user_id ON account_recovery_codes(user_id);
CREATE INDEX idx_account_recovery_codes_expires_at ON account_recovery_codes(expires_at);
