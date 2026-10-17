-- One review date. Policy items used to state their own review_date field,
-- which was copied into items.review_by on publish; "Still accurate" then
-- moved only review_by, so the two could disagree. items.review_by is now the
-- only review date. The per-library review period and strict mode are gone:
-- Policy and Procedure libraries get publish day + 90 days, other libraries
-- get no automatic date (a publisher can still set one on the item page).

-- 1. Published Policy items with no review_by yet take the review_date of
--    their published copy. (Earlier publishes already copied it.)
UPDATE items i
SET review_by = (((i.published_snapshot::jsonb ->> 'details')::jsonb) ->> 'review_date')::date
FROM libraries l
WHERE l.id = i.library_id
  AND l.template = 'policy'
  AND i.review_by IS NULL
  AND i.published_snapshot IS NOT NULL
  AND pg_input_is_valid(i.published_snapshot, 'jsonb')
  AND pg_input_is_valid(i.published_snapshot::jsonb ->> 'details', 'jsonb')
  AND jsonb_typeof((i.published_snapshot::jsonb ->> 'details')::jsonb) = 'object'
  AND (((i.published_snapshot::jsonb ->> 'details')::jsonb) ->> 'review_date') ~ '^\d{4}-\d{2}-\d{2}$'
  AND pg_input_is_valid(((i.published_snapshot::jsonb ->> 'details')::jsonb) ->> 'review_date', 'date');

-- 2. Drop review_date from Policy items: the working row and both published
--    copies. Not a new publish, so the version and review_by triggers pause.
ALTER TABLE items DISABLE TRIGGER items_published_version;
ALTER TABLE items DISABLE TRIGGER items_review_by;

UPDATE items i
SET details = (i.details::jsonb - 'review_date')::text
FROM libraries l
WHERE l.id = i.library_id AND l.template = 'policy'
  AND pg_input_is_valid(i.details, 'jsonb')
  AND jsonb_typeof(i.details::jsonb) = 'object'
  AND i.details::jsonb -> 'review_date' IS NOT NULL;

UPDATE items i
SET published_snapshot = jsonb_set(
  i.published_snapshot::jsonb, '{details}',
  to_jsonb((((i.published_snapshot::jsonb ->> 'details')::jsonb) - 'review_date')::text)
)::text
FROM libraries l
WHERE l.id = i.library_id AND l.template = 'policy'
  AND pg_input_is_valid(i.published_snapshot, 'jsonb')
  AND pg_input_is_valid(i.published_snapshot::jsonb ->> 'details', 'jsonb')
  AND jsonb_typeof((i.published_snapshot::jsonb ->> 'details')::jsonb) = 'object'
  AND ((i.published_snapshot::jsonb ->> 'details')::jsonb) -> 'review_date' IS NOT NULL;

UPDATE items i
SET previous_published_snapshot = jsonb_set(
  i.previous_published_snapshot::jsonb, '{details}',
  to_jsonb((((i.previous_published_snapshot::jsonb ->> 'details')::jsonb) - 'review_date')::text)
)::text
FROM libraries l
WHERE l.id = i.library_id AND l.template = 'policy'
  AND pg_input_is_valid(i.previous_published_snapshot, 'jsonb')
  AND pg_input_is_valid(i.previous_published_snapshot::jsonb ->> 'details', 'jsonb')
  AND jsonb_typeof((i.previous_published_snapshot::jsonb ->> 'details')::jsonb) = 'object'
  AND ((i.previous_published_snapshot::jsonb ->> 'details')::jsonb) -> 'review_date' IS NOT NULL;

ALTER TABLE items ENABLE TRIGGER items_published_version;
ALTER TABLE items ENABLE TRIGGER items_review_by;

-- 3. Policy library schemas lose the Review date field.
UPDATE libraries
SET schema = jsonb_set(schema, '{fields}', COALESCE((
  SELECT jsonb_agg(field ORDER BY pos)
  FROM jsonb_array_elements(schema -> 'fields') WITH ORDINALITY AS f(field, pos)
  WHERE field ->> 'key' IS DISTINCT FROM 'review_date'
), '[]'::jsonb))
WHERE schema ->> 'starter' = 'policy'
  AND jsonb_typeof(schema -> 'fields') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(schema -> 'fields') AS e(field) WHERE field ->> 'key' = 'review_date');

-- 4. On publish: publish day + 90 for Policy and Procedure libraries. Other
--    libraries keep whatever date a publisher set by hand (or none).
CREATE OR REPLACE FUNCTION items_set_review_by() RETURNS trigger LANGUAGE plpgsql AS '
BEGIN
  IF NEW.published_snapshot IS NOT NULL AND (
    TG_OP = ''INSERT'' OR NEW.published_snapshot IS DISTINCT FROM OLD.published_snapshot
  ) AND EXISTS (
    SELECT 1 FROM libraries WHERE id = NEW.library_id AND template IN (''policy'', ''procedure'')
  ) THEN
    NEW.review_by := (to_timestamp(NEW.updated_at / 1000.0) AT TIME ZONE ''UTC'')::date + 90;
  END IF;
  RETURN NEW;
END;
';

DROP FUNCTION IF EXISTS item_review_by_for(VARCHAR, TEXT, BIGINT);
DROP FUNCTION IF EXISTS library_review_days(VARCHAR);

ALTER TABLE libraries DROP COLUMN IF EXISTS review_days;
ALTER TABLE libraries DROP COLUMN IF EXISTS strict_freshness;
