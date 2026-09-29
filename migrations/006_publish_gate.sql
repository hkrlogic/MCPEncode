-- Draft → published gate: archived status, last-published snapshot, publish_audit.
-- Applied once. Idempotent where MariaDB allows. Does not drop any table.

ALTER TABLE items ADD COLUMN IF NOT EXISTS published_snapshot MEDIUMTEXT NULL;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_known;
ALTER TABLE items ADD CONSTRAINT items_status_known CHECK (status IN ('draft', 'published', 'archived'));

ALTER TABLE publish_audit DROP CONSTRAINT IF EXISTS publish_audit_to_status;
ALTER TABLE publish_audit ADD CONSTRAINT publish_audit_to_status CHECK (to_status IN ('draft', 'published', 'archived'));

-- Seed snapshot for rows already live so Diff works after the first unpublish.
UPDATE items
SET published_snapshot = CONCAT(
  '{"name":', JSON_QUOTE(name),
  ',"labels":', IFNULL(NULLIF(TRIM(labels), ''), '[]'),
  ',"summary":', JSON_QUOTE(summary),
  ',"body":', JSON_QUOTE(body),
  ',"details":', IF(details IS NULL, 'null', JSON_QUOTE(details)),
  ',"published_at":', updated_at,
  '}'
)
WHERE status = 'published'
  AND (published_snapshot IS NULL OR published_snapshot = '');
