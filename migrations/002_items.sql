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
-- Older POC files may lack records.library_id. The migration runner applies
-- this statement only when that column is missing (SQLite ADD COLUMN is not
-- repeated safely from this file):
--   ALTER TABLE records ADD COLUMN library_id TEXT NOT NULL DEFAULT '';
--
-- Rollback (not applied here):
--   1. Point reads back at records. This copy is a snapshot. Items written
--      after the migration are not in records.
--   2. DROP TABLE publish_audit; DROP TABLE items;
--      DELETE FROM schema_migrations WHERE version = '002_items.sql';
--   3. Leave records in place. This file never drops it.

INSERT INTO libraries (id, name, created_by, updated_by, created_at, updated_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Main',
  'system',
  'system',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM libraries);

-- Empty or unknown library_id cannot be copied (items.library_id is required).
UPDATE records
SET library_id = (
  SELECT id FROM libraries ORDER BY created_at ASC, id ASC LIMIT 1
)
WHERE trim(library_id) = ''
   OR library_id NOT IN (SELECT id FROM libraries);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  name TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  data TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (library_id) REFERENCES libraries (id)
);

CREATE TABLE IF NOT EXISTS publish_audit (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL CHECK (to_status IN ('draft', 'published')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (library_id) REFERENCES libraries (id),
  FOREIGN KEY (item_id) REFERENCES items (id)
);

CREATE INDEX IF NOT EXISTS items_library_status_updated
  ON items (library_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS publish_audit_library_created
  ON publish_audit (library_id, created_at DESC);
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
  substr(
    replace(
      replace(
        CASE WHEN trim(paragraph) = '' THEN title ELSE trim(paragraph) END,
        char(13),
        ' '
      ),
      char(10),
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
      WHEN instr(trim(r.notes) || char(10) || char(10), char(10) || char(10)) > 1
        THEN substr(
          trim(r.notes),
          1,
          instr(trim(r.notes) || char(10) || char(10), char(10) || char(10)) - 1
        )
      ELSE trim(r.notes)
    END AS paragraph
  FROM records AS r
  WHERE trim(r.library_id) <> ''
    AND NOT EXISTS (SELECT 1 FROM items AS i WHERE i.id = r.id)
);
