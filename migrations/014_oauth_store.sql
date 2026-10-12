-- The built-in identity provider keeps its state in Postgres, so a restart
-- does not sign everyone out and a client registration survives a deploy.

-- Dynamic client registrations (RFC 7591). Public clients only (PKCE, no secret).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id VARCHAR(64) NOT NULL,
  client_name VARCHAR(200) NOT NULL DEFAULT '',
  redirect_uris JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (client_id)
);

-- Refresh tokens, stored as SHA-256 hashes. One sign-in is one chain; every
-- refresh adds a row and marks the previous one used. A used token presented
-- again means the chain leaked, and the whole chain is deleted.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash CHAR(64) NOT NULL,
  chain_id VARCHAR(36) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  resource TEXT NOT NULL,
  chain_started_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  PRIMARY KEY (token_hash)
);
CREATE INDEX IF NOT EXISTS oauth_refresh_chain ON oauth_refresh_tokens (chain_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_subject ON oauth_refresh_tokens (subject);
CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_tokens (client_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_chain_started ON oauth_refresh_tokens (chain_started_at);

-- Token signing key. The private key is encrypted with a key derived from
-- SESSION_SECRET; a changed secret makes it unreadable and a new key is made.
CREATE TABLE IF NOT EXISTS oauth_signing_keys (
  kid VARCHAR(64) NOT NULL,
  public_jwk JSONB NOT NULL,
  private_jwk_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  retired_at BIGINT,
  PRIMARY KEY (kid)
);

-- Sign-out and password changes end every session and access token issued before this time (ms).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sessions_revoked_at BIGINT;
