-- Scope tool-call audit events to a library, so list_audit on one library's
-- Connect link cannot read what happened in another library.
-- Older rows are backfilled where the library can be worked out from the detail.
-- Rows that cannot be tied to a library keep library_id NULL and are not listed.

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS library_id VARCHAR(36);

-- MCP lookups wrote "... library=<id>".
UPDATE audit_events
SET library_id = substring(detail FROM 'library=([0-9a-fA-F-]{36})')
WHERE library_id IS NULL
  AND detail ~ 'library=[0-9a-fA-F-]{36}';

-- Item tools wrote the item id. The item still names its library.
UPDATE audit_events AS a
SET library_id = i.library_id
FROM items AS i
WHERE a.library_id IS NULL
  AND i.id = a.detail;

-- Library tools wrote the library id, alone or before a colon.
UPDATE audit_events AS a
SET library_id = l.id
FROM libraries AS l
WHERE a.library_id IS NULL
  AND (a.detail = l.id OR a.detail LIKE l.id || ':%');

CREATE INDEX IF NOT EXISTS audit_library_created ON audit_events (library_id, created_at);
