-- Stable per-library key for agent upsert / handoff.
-- Null means "no key" (UI-only or older items). Non-null keys are unique inside one library.
ALTER TABLE items ADD COLUMN IF NOT EXISTS entity_key VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS items_library_entity_key
  ON items (library_id, entity_key)
  WHERE entity_key IS NOT NULL;
