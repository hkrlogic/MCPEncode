-- One Reader key per library. The secret is never stored — only a SHA-256 hash.
-- Null hash means the library has no Reader key.
-- Rotate replaces the hash immediately. Removing the key sets these back to null.
-- Independent of connect_token: rotating Connect does not change this key.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS reader_key_hash TEXT;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS reader_key_prefix VARCHAR(16);
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS reader_key_created_at BIGINT;
