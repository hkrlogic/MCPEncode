-- Sign-in accounts for the built-in identity provider.
-- The password column stores a scrypt hash, never the password itself.
-- id is the OAuth subject (sub) granted on a library access list.

CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR(36) NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (username),
  CONSTRAINT accounts_role_check CHECK (role IN ('edit', 'readonly'))
);
