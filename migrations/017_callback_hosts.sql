-- Remote https callback hosts a site admin approved or denied in the app.
-- Approved hosts are added to OAUTH_REDIRECT_HOSTS (the union is what counts).
-- A hosted MCP client whose callback host is not approved yet adds a pending
-- row; pending rows are capped (see OAUTH_LIMITS.maxPendingCallbackHosts).
-- sample_client_name is the client's own client_name: unverified.
CREATE TABLE IF NOT EXISTS callback_hosts (
  host VARCHAR(253) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  sample_client_name VARCHAR(200) NOT NULL DEFAULT '',
  decided_by VARCHAR(255),
  decided_at BIGINT,
  PRIMARY KEY (host)
);
CREATE INDEX IF NOT EXISTS callback_hosts_status ON callback_hosts (status, last_seen);
