-- Per-library field schema (copy-on-create from a starter).
-- Values stay on items; this column is the contract for that library.
-- Backfill of NULL rows runs in applyMigrations (TypeScript) from starter defs.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS schema JSONB;
