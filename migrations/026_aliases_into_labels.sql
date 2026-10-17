-- Aliases fold into labels. Search already matched and ranked aliases exactly
-- like labels, and both went through Review Lock the same way, so one list
-- does the job: "phished" or "suspicious email" is simply a label.
-- Each item keeps its labels first, then any alias it did not already have
-- (lower case, trimmed, first-seen order). Nothing is dropped: an item that
-- ends up over the 20-label limit keeps every word, and the next edit asks
-- for fewer. The published copies get the same merge without counting as a
-- new publish.

CREATE OR REPLACE FUNCTION mcpencode_merge_labels(labels JSONB, aliases JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(label ORDER BY first_pos), '[]'::jsonb)
  FROM (
    SELECT label, MIN(pos) AS first_pos
    FROM (
      SELECT lower(btrim(value)) AS label, pos
      FROM jsonb_array_elements_text(
        (CASE WHEN jsonb_typeof(labels) = 'array' THEN labels ELSE '[]'::jsonb END) ||
        (CASE WHEN jsonb_typeof(aliases) = 'array' THEN aliases ELSE '[]'::jsonb END)
      ) WITH ORDINALITY AS t(value, pos)
    ) cleaned
    WHERE label <> ''
    GROUP BY label
  ) merged
$$;

UPDATE items SET labels = mcpencode_merge_labels(labels, aliases)
WHERE jsonb_typeof(aliases) = 'array' AND jsonb_array_length(aliases) > 0;

ALTER TABLE items DISABLE TRIGGER items_published_version;
ALTER TABLE items DISABLE TRIGGER items_review_by;

UPDATE items
SET published_snapshot = (
  jsonb_set(published_snapshot::jsonb, '{labels}',
    mcpencode_merge_labels(published_snapshot::jsonb -> 'labels', published_snapshot::jsonb -> 'aliases')) - 'aliases'
)::text
WHERE published_snapshot IS NOT NULL
  AND pg_input_is_valid(published_snapshot, 'jsonb')
  AND jsonb_typeof(published_snapshot::jsonb) = 'object'
  AND published_snapshot::jsonb -> 'aliases' IS NOT NULL;

UPDATE items
SET previous_published_snapshot = (
  jsonb_set(previous_published_snapshot::jsonb, '{labels}',
    mcpencode_merge_labels(previous_published_snapshot::jsonb -> 'labels', previous_published_snapshot::jsonb -> 'aliases')) - 'aliases'
)::text
WHERE previous_published_snapshot IS NOT NULL
  AND pg_input_is_valid(previous_published_snapshot, 'jsonb')
  AND jsonb_typeof(previous_published_snapshot::jsonb) = 'object'
  AND previous_published_snapshot::jsonb -> 'aliases' IS NOT NULL;

ALTER TABLE items ENABLE TRIGGER items_published_version;
ALTER TABLE items ENABLE TRIGGER items_review_by;

DROP FUNCTION mcpencode_merge_labels(JSONB, JSONB);

-- The view loses its aliases column (CREATE OR REPLACE cannot drop one).
DROP VIEW IF EXISTS items_live;
CREATE VIEW items_live AS
SELECT
  i.id,
  i.library_id,
  i.entity_key,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN (i.published_snapshot::jsonb ->> 'name') ELSE i.name END AS name,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN COALESCE(i.published_snapshot::jsonb -> 'labels', '[]'::jsonb) ELSE i.labels END AS labels,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN (i.published_snapshot::jsonb ->> 'summary') ELSE i.summary END AS summary,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN (i.published_snapshot::jsonb ->> 'body') ELSE i.body END AS body,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN (i.published_snapshot::jsonb ->> 'details') ELSE i.details END AS details,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN 'published' ELSE i.status END AS status,
  i.published_snapshot,
  i.previous_published_snapshot,
  (i.status = 'draft' AND i.published_live) AS has_pending_changes,
  i.created_by,
  i.updated_by,
  i.created_at,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN COALESCE((i.published_snapshot::jsonb ->> 'published_at')::numeric::bigint, i.created_at)
    ELSE i.updated_at END AS updated_at,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN
      setweight(to_tsvector('english', coalesce(i.published_snapshot::jsonb ->> 'name', '')), 'A') ||
      setweight(to_tsvector('english', coalesce(i.published_snapshot::jsonb ->> 'summary', '')), 'B') ||
      setweight(to_tsvector('english', coalesce(i.published_snapshot::jsonb ->> 'body', '')), 'C')
    ELSE i.search_tsv END AS search_tsv
FROM items i;

ALTER TABLE items DROP COLUMN IF EXISTS aliases;
