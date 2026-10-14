-- Labels used to be stored exactly as an agent sent them over MCP ("Ops",
-- " ops", "ops" twice), while the web form stored them trimmed, lower case and
-- unique. Label filters match exactly, so the variants split results. From now
-- on every write normalizes labels; this backfills existing rows the same way:
-- trim, lower case, drop empties and duplicates, keep first-seen order.
-- The published copy (published_snapshot, previous_published_snapshot) carries
-- its own labels list, which Readers see, so it is normalized too.

CREATE OR REPLACE FUNCTION mcpencode_normalize_labels(input JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(label ORDER BY first_pos), '[]'::jsonb)
  FROM (
    SELECT label, MIN(pos) AS first_pos
    FROM (
      SELECT lower(btrim(value)) AS label, pos
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(input) = 'array' THEN input ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS t(value, pos)
    ) cleaned
    WHERE label <> ''
    GROUP BY label
  ) unique_labels
$$;

UPDATE items
SET labels = mcpencode_normalize_labels(labels)
WHERE jsonb_typeof(labels) = 'array'
  AND labels IS DISTINCT FROM mcpencode_normalize_labels(labels);

-- Snapshots are TEXT holding JSON; only touch ones that parse to an object with a labels array.
-- A label clean-up is not a new publish: keep published_version (citations),
-- published_by and review_by as they are by pausing those triggers here.
ALTER TABLE items DISABLE TRIGGER items_published_version;
ALTER TABLE items DISABLE TRIGGER items_review_by;

UPDATE items
SET published_snapshot = jsonb_set(published_snapshot::jsonb, '{labels}', mcpencode_normalize_labels(published_snapshot::jsonb -> 'labels'))::text
WHERE published_snapshot IS NOT NULL
  AND jsonb_typeof((CASE WHEN pg_input_is_valid(published_snapshot, 'jsonb') THEN published_snapshot::jsonb END) -> 'labels') = 'array'
  AND ((CASE WHEN pg_input_is_valid(published_snapshot, 'jsonb') THEN published_snapshot::jsonb END) -> 'labels') IS DISTINCT FROM mcpencode_normalize_labels((CASE WHEN pg_input_is_valid(published_snapshot, 'jsonb') THEN published_snapshot::jsonb END) -> 'labels');

UPDATE items
SET previous_published_snapshot = jsonb_set(previous_published_snapshot::jsonb, '{labels}', mcpencode_normalize_labels(previous_published_snapshot::jsonb -> 'labels'))::text
WHERE previous_published_snapshot IS NOT NULL
  AND jsonb_typeof((CASE WHEN pg_input_is_valid(previous_published_snapshot, 'jsonb') THEN previous_published_snapshot::jsonb END) -> 'labels') = 'array'
  AND ((CASE WHEN pg_input_is_valid(previous_published_snapshot, 'jsonb') THEN previous_published_snapshot::jsonb END) -> 'labels') IS DISTINCT FROM mcpencode_normalize_labels((CASE WHEN pg_input_is_valid(previous_published_snapshot, 'jsonb') THEN previous_published_snapshot::jsonb END) -> 'labels');

ALTER TABLE items ENABLE TRIGGER items_published_version;
ALTER TABLE items ENABLE TRIGGER items_review_by;

DROP FUNCTION mcpencode_normalize_labels(JSONB);
