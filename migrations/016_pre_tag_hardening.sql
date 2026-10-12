-- Pending OAuth registrations are counted per client address (IPv6 per /64).
-- registered_from is a SHA-256 of that address key, not the address itself.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS registered_from CHAR(64);
CREATE INDEX IF NOT EXISTS oauth_clients_registered_from ON oauth_clients (registered_from, created_at);

-- Addresses a username signed in from successfully, for the sign-in throttle
-- bypass. pair_hash is SHA-256 of username + address key (IPv6 per /64), so no
-- username or address is stored. Rows expire after 30 days; the table is capped.
CREATE TABLE IF NOT EXISTS signin_known_good (
  pair_hash CHAR(64) NOT NULL,
  last_success BIGINT NOT NULL,
  PRIMARY KEY (pair_hash)
);
CREATE INDEX IF NOT EXISTS signin_known_good_last ON signin_known_good (last_success);
