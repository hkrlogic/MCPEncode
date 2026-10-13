-- Review Lock: keep the last published copy live while an edit is Pending.
--
-- published_live = true means: status is 'draft' (Pending), and the copy in
-- published_snapshot is still what Readers and agents see. Publishing the
-- edit replaces it; Cancel drops the edit and keeps it. Unpublish, Archive and
-- Restore set it to false. It is never true for a row without a readable
-- published_snapshot.
ALTER TABLE items ADD COLUMN IF NOT EXISTS published_live BOOLEAN NOT NULL DEFAULT false;

-- Backfill. A Pending item goes live again with its last published copy when:
--   * it has a readable published_snapshot (name, summary, body are strings),
--   * its latest status change was published -> draft (an edit, a file change,
--     or Unpublish; Restore from Archives is archived -> draft and stays hidden),
--   * nobody pressed Unpublish on it at or after that change.
-- Everything else stays hidden as before (never published, unpublished on
-- purpose, restored from Archives, or a snapshot that cannot be read).
UPDATE items AS i
SET published_live = true
WHERE i.status = 'draft'
  AND i.published_live = false
  AND i.published_snapshot IS NOT NULL
  AND pg_input_is_valid(i.published_snapshot, 'jsonb')
  AND jsonb_typeof(i.published_snapshot::jsonb) = 'object'
  AND jsonb_typeof(i.published_snapshot::jsonb -> 'name') = 'string'
  AND jsonb_typeof(i.published_snapshot::jsonb -> 'summary') = 'string'
  AND jsonb_typeof(i.published_snapshot::jsonb -> 'body') = 'string'
  AND (
    SELECT pa.from_status
    FROM publish_audit pa
    WHERE pa.item_id = i.id AND pa.to_status = 'draft'
    ORDER BY pa.created_at DESC
    LIMIT 1
  ) = 'published'
  AND NOT EXISTS (
    SELECT 1
    FROM publish_audit pa
    WHERE pa.item_id = i.id
      AND pa.created_at > (
        SELECT MAX(pa2.created_at) FROM publish_audit pa2
        WHERE pa2.item_id = i.id AND pa2.to_status = 'draft'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM audit_events e
    WHERE e.tool = 'ui.unpublish'
      AND e.detail = i.id
      AND e.created_at >= (
        SELECT MAX(pa3.created_at) - 1000 FROM publish_audit pa3
        WHERE pa3.item_id = i.id AND pa3.to_status = 'draft' AND pa3.from_status = 'published'
      )
  );

-- What Readers and agents see. A Pending edit on a live item shows its
-- published copy (text and search document); every other row shows its own
-- columns. Reader queries filter this view on status = 'published', so draft
-- text never reaches a Reader, by list, open, or full-text search.
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
    ELSE i.search_tsv END AS search_tsv
FROM items i;
