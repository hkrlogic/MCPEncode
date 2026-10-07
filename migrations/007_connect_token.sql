-- Rotatable secret in the library MCP URL.
-- Knowing the library id alone is not enough to open MCP.
-- Rotate under Actions; Remove on Access still drops one person's grant.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS connect_token VARCHAR(64);

UPDATE libraries
SET connect_token = md5(random()::text || id || clock_timestamp()::text)
                 || md5(random()::text || coalesce(name, '') || clock_timestamp()::text)
WHERE connect_token IS NULL OR connect_token = '';

ALTER TABLE libraries ALTER COLUMN connect_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS libraries_connect_token_uidx
  ON libraries (connect_token);
