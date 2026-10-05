-- Who may open a library (IdP subject) and their role on that library.
-- reader: published items only. publisher: drafts, publish, and manage this list.
-- MCP connects per library; this table is the gate for that link.

CREATE TABLE IF NOT EXISTS library_access (
  library_id VARCHAR(36) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL,
  granted_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (library_id, subject),
  CONSTRAINT library_access_role_known CHECK (role IN ('reader', 'publisher')),
  CONSTRAINT library_access_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS library_access_subject ON library_access (subject);

-- Existing libraries: creator becomes publisher when the subject is real.
INSERT INTO library_access (library_id, subject, role, granted_by, created_at)
SELECT
  id,
  created_by,
  'publisher',
  created_by,
  CAST(UNIX_TIMESTAMP() * 1000 AS SIGNED)
FROM libraries
WHERE created_by <> 'system'
  AND created_by <> ''
  AND NOT EXISTS (
    SELECT 1 FROM library_access a
    WHERE a.library_id = libraries.id AND a.subject = libraries.created_by
  );
