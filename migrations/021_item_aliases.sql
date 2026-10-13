-- Per-item aliases: other words people use for the same thing ("phished",
-- "suspicious email"). Search matches and ranks them like labels. They are
-- part of the published copy, so an alias change goes through Review Lock
-- like any other edit and only reaches Readers on Publish.
ALTER TABLE items ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Same view as 018 plus aliases (appended last, as CREATE OR REPLACE VIEW
-- requires). A Pending edit on a live item shows the published aliases.
CREATE OR REPLACE VIEW items_live AS
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
    ELSE i.search_tsv END AS search_tsv,
  CASE WHEN i.status = 'draft' AND i.published_live
    THEN COALESCE(i.published_snapshot::jsonb -> 'aliases', '[]'::jsonb) ELSE i.aliases END AS aliases
FROM items i;
