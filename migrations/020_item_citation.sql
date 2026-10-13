-- Citation metadata for agents: a published version number and who published it.
-- published_version counts how many times the published copy (published_snapshot)
-- changed: Publish, a Review Unlock save, or Revert. 0 = never published.
-- published_by is the subject that made that change (updated_by at that moment).
ALTER TABLE items ADD COLUMN IF NOT EXISTS published_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS published_by VARCHAR(255) NULL;

-- Items published before this migration start at version 1. Their publisher is
-- not recorded anywhere, so published_by stays NULL rather than guessing.
UPDATE items SET published_version = 1
WHERE published_snapshot IS NOT NULL AND published_version = 0;

-- One trigger covers every code path that changes the published copy.
-- Body is single-quoted (not $$) because the migration runner splits on ";"
-- outside quotes.
CREATE OR REPLACE FUNCTION items_track_published_version() RETURNS trigger LANGUAGE plpgsql AS '
BEGIN
  IF NEW.published_snapshot IS NOT NULL AND (
    TG_OP = ''INSERT'' OR NEW.published_snapshot IS DISTINCT FROM OLD.published_snapshot
  ) THEN
    IF TG_OP = ''INSERT'' THEN
      NEW.published_version := 1;
    ELSE
      NEW.published_version := COALESCE(OLD.published_version, 0) + 1;
    END IF;
    NEW.published_by := NEW.updated_by;
  END IF;
  RETURN NEW;
END;
';

DROP TRIGGER IF EXISTS items_published_version ON items;
CREATE TRIGGER items_published_version
  BEFORE INSERT OR UPDATE OF published_snapshot ON items
  FOR EACH ROW EXECUTE FUNCTION items_track_published_version();
