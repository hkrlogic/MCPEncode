-- Store Connect tokens as SHA-256 only.
-- Existing tokens are hashed in place, so links already handed out keep working.
-- The plaintext column is then dropped. connect_token_last4 is the non-secret
-- tail shown in the publisher ("…a1b2").
-- Plain SHA-256 (not HMAC): tokens are 32 random bytes, so a fast unkeyed hash
-- is enough, and rotating SESSION_SECRET does not break every Connect link.
-- Idempotent: a second run finds no connect_token column and changes nothing.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS connect_token_hash CHAR(64);
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS connect_token_last4 VARCHAR(8);

-- Single-quoted body (not $$) because the migration runner splits on ';'
-- outside quotes. One DO block, so hash + drop happen together or not at all.
DO '
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ''libraries''
      AND column_name = ''connect_token''
  ) THEN
    UPDATE libraries
    SET connect_token_hash = encode(sha256(convert_to(connect_token, ''UTF8'')), ''hex''),
        connect_token_last4 = right(connect_token, 4)
    WHERE connect_token_hash IS NULL
      AND connect_token IS NOT NULL
      AND connect_token <> '''';
    DROP INDEX IF EXISTS libraries_connect_token_uidx;
    ALTER TABLE libraries DROP COLUMN connect_token;
  END IF;
END
';

-- A row with no token (should not exist) gets a hash nobody holds: rotate to use it.
UPDATE libraries
SET connect_token_hash = encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
    connect_token_last4 = NULL
WHERE connect_token_hash IS NULL;

ALTER TABLE libraries ALTER COLUMN connect_token_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS libraries_connect_token_hash_uidx
  ON libraries (connect_token_hash);
