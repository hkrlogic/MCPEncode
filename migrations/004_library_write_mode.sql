-- Per-library write policy.
-- reviewed = saves stay Pending until a human Publishes (default, current behavior).
-- direct = successful saves are Published immediately (live for readers and agents).
ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS write_mode VARCHAR(16) NOT NULL DEFAULT 'reviewed';

ALTER TABLE libraries DROP CONSTRAINT IF EXISTS libraries_write_mode_known;
ALTER TABLE libraries
  ADD CONSTRAINT libraries_write_mode_known
  CHECK (write_mode IN ('reviewed', 'direct'));
