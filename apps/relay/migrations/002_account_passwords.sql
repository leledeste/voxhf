ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE INDEX idx_users_password_hash ON users(password_hash);
