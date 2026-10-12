-- One-time rotation of Connect tokens made by migration 007.
-- 007 filled existing libraries with md5(random() …): 64 hex characters from
-- a generator that is not meant for secrets. Libraries created by the app get
-- 32 random bytes as base64url (43 characters) and are left alone.
-- The new token is 32 bytes from two gen_random_uuid() calls (a CSPRNG,
-- built into Postgres 13+), written as base64url like the app's own tokens.
-- Agents using an old link must copy the new one from Connect.

UPDATE libraries
SET connect_token = rtrim(
      translate(
        encode(
          decode(
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
            'hex'
          ),
          'base64'
        ),
        '+/',
        '-_'
      ),
      '='
    )
WHERE connect_token ~ '^[0-9a-f]{64}$';
