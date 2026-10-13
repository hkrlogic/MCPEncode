-- Freshness: every published item can carry a review-by date.
--
-- libraries.review_days: days after a publish until review is due.
--   NULL = the type default (90 for Policy and Procedure, off for the rest);
--   0 = off; any other value applies to every item in the library.
-- libraries.strict_freshness: when true, agents are refused items past review.
-- items.review_by: the date the published copy must be re-checked by. Kept
--   outside published_snapshot: re-confirming it is not a content change and
--   does not bump the citation version.
-- items.reviewed_at / reviewed_by: last "Still accurate" confirmation.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS review_days INTEGER NULL;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS strict_freshness BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS review_by DATE NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reviewed_at BIGINT NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(255) NULL;

CREATE OR REPLACE FUNCTION library_review_days(lib_id VARCHAR) RETURNS INTEGER LANGUAGE sql STABLE AS '
  SELECT COALESCE(review_days, CASE WHEN template IN (''policy'', ''procedure'') THEN 90 ELSE 0 END)
  FROM libraries WHERE id = lib_id
';

-- Review-by for a newly published copy. A Policy item already states its own
-- review_date; that wins. Otherwise publish day + the library default.
CREATE OR REPLACE FUNCTION item_review_by_for(lib_id VARCHAR, details TEXT, published_ms BIGINT) RETURNS DATE LANGUAGE plpgsql STABLE AS '
DECLARE
  stated TEXT;
  days INTEGER;
BEGIN
  IF details IS NOT NULL AND pg_input_is_valid(details, ''jsonb'') AND jsonb_typeof(details::jsonb) = ''object'' THEN
    stated := details::jsonb ->> ''review_date'';
    IF stated ~ ''^\d{4}-\d{2}-\d{2}$'' AND pg_input_is_valid(stated, ''date'') THEN
      RETURN stated::date;
    END IF;
  END IF;
  days := COALESCE(library_review_days(lib_id), 0);
  IF days > 0 THEN
    RETURN (to_timestamp(published_ms / 1000.0) AT TIME ZONE ''UTC'')::date + days;
  END IF;
  RETURN NULL;
END;
';

CREATE OR REPLACE FUNCTION items_set_review_by() RETURNS trigger LANGUAGE plpgsql AS '
BEGIN
  IF NEW.published_snapshot IS NOT NULL AND (
    TG_OP = ''INSERT'' OR NEW.published_snapshot IS DISTINCT FROM OLD.published_snapshot
  ) THEN
    NEW.review_by := COALESCE(item_review_by_for(NEW.library_id, NEW.details, NEW.updated_at), NEW.review_by);
  END IF;
  RETURN NEW;
END;
';

DROP TRIGGER IF EXISTS items_review_by ON items;
CREATE TRIGGER items_review_by
  BEFORE INSERT OR UPDATE OF published_snapshot ON items
  FOR EACH ROW EXECUTE FUNCTION items_set_review_by();

-- Backfill published items from their published copy.
UPDATE items SET review_by = item_review_by_for(
  library_id,
  CASE WHEN pg_input_is_valid(published_snapshot, 'jsonb') THEN published_snapshot::jsonb ->> 'details' ELSE details END,
  CASE WHEN pg_input_is_valid(published_snapshot, 'jsonb')
       AND jsonb_typeof(published_snapshot::jsonb -> 'published_at') = 'number'
    THEN (published_snapshot::jsonb ->> 'published_at')::numeric::bigint ELSE updated_at END
)
WHERE published_snapshot IS NOT NULL AND review_by IS NULL;
