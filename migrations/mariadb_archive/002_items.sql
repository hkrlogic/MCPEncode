-- Library → Item.
-- Copies notes-style rows from records into items. Does not DROP records.
--
-- Default library (only when libraries is empty):
--   id   00000000-0000-4000-8000-000000000001
--   name Main
-- When a library already exists, that oldest library is the backfill target.
--
-- Backfill status is 'published' because those rows were already the live corpus.
-- New inserts use the column default 'draft'.
-- Summary is the first paragraph of notes (text before the first blank line),
-- collapsed to one line, at most 500 characters. An empty body uses the name.
--
-- Older databases may lack records.library_id. The migration runner adds
-- that column only when it is missing:
--   ALTER TABLE records ADD COLUMN library_id VARCHAR(36) NOT NULL DEFAULT '';
--
-- Rollback (not applied here):
--   1. Point reads back at records. This copy is a snapshot. Items written
--      after the migration are not in records.
--   2. Drop publish_audit and items by hand, then delete this version from
--      schema_migrations.
--   3. Leave records in place. This file never drops it.

INSERT INTO libraries (id, name, created_by, updated_by, created_at, updated_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Main',
  'system',
  'system',
  CAST(UNIX_TIMESTAMP() * 1000 AS SIGNED),
  CAST(UNIX_TIMESTAMP() * 1000 AS SIGNED)
WHERE NOT EXISTS (SELECT 1 FROM libraries);

-- Empty or unknown library_id cannot be copied (items.library_id is required).
UPDATE records
SET library_id = (
  SELECT id FROM libraries ORDER BY created_at ASC, id ASC LIMIT 1
)
WHERE TRIM(library_id) = ''
   OR library_id NOT IN (SELECT id FROM libraries);

CREATE TABLE IF NOT EXISTS items (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  labels TEXT NOT NULL DEFAULT ('[]'),
  summary VARCHAR(500) NOT NULL,
  data MEDIUMTEXT NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT items_summary_not_blank CHECK (CHAR_LENGTH(TRIM(summary)) > 0),
  CONSTRAINT items_status_known CHECK (status IN ('draft', 'published')),
  CONSTRAINT items_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS publish_audit (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  actor_sub VARCHAR(255) NOT NULL,
  from_status VARCHAR(16) NOT NULL,
  to_status VARCHAR(16) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT publish_audit_to_status CHECK (to_status IN ('draft', 'published')),
  CONSTRAINT publish_audit_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id),
  CONSTRAINT publish_audit_item_fk FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS items_library_status_updated
  ON items (library_id, status, updated_at);
CREATE INDEX IF NOT EXISTS publish_audit_library_created
  ON publish_audit (library_id, created_at);
CREATE INDEX IF NOT EXISTS records_library_id ON records (library_id);

-- One-time copy. Re-running does not duplicate ids and does not update rows
-- already copied (records stays the pre-migration snapshot).
INSERT INTO items (
  id, library_id, name, labels, summary, data, status,
  created_by, updated_by, created_at, updated_at
)
SELECT
  id,
  library_id,
  title,
  tags,
  SUBSTRING(
    REPLACE(
      REPLACE(
        CASE WHEN TRIM(paragraph) = '' THEN title ELSE TRIM(paragraph) END,
        CHAR(13),
        ' '
      ),
      CHAR(10),
      ' '
    ),
    1,
    500
  ),
  notes,
  'published',
  created_by,
  updated_by,
  created_at,
  updated_at
FROM (
  SELECT
    r.*,
    CASE
      WHEN INSTR(CONCAT(TRIM(r.notes), CHAR(10), CHAR(10)), CONCAT(CHAR(10), CHAR(10))) > 1
        THEN SUBSTRING(
          TRIM(r.notes),
          1,
          INSTR(CONCAT(TRIM(r.notes), CHAR(10), CHAR(10)), CONCAT(CHAR(10), CHAR(10))) - 1
        )
      ELSE TRIM(r.notes)
    END AS paragraph
  FROM records AS r
  WHERE TRIM(r.library_id) <> ''
    AND NOT EXISTS (SELECT 1 FROM items AS i WHERE i.id = r.id)
) AS source;
