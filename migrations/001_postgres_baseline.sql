-- PostgreSQL baseline (current product end-state).
-- Applied once on a fresh database. Historical SQL (not applied) lives in migrations/mariadb_archive/.
-- Times are Unix milliseconds (BIGINT). records is frozen (kept empty; no new writes).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS libraries (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  template VARCHAR(32) NOT NULL DEFAULT 'general',
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS records (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL DEFAULT '',
  title VARCHAR(200) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(36) NOT NULL,
  actor_sub VARCHAR(255) NOT NULL,
  tool VARCHAR(64) NOT NULL,
  success BOOLEAN NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS items (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary VARCHAR(500) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  details TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  published_snapshot TEXT NULL,
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT items_summary_not_blank CHECK (LENGTH(TRIM(summary)) > 0),
  CONSTRAINT items_status_known CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT items_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id)
);

CREATE TABLE IF NOT EXISTS publish_audit (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  actor_sub VARCHAR(255) NOT NULL,
  from_status VARCHAR(16) NOT NULL,
  to_status VARCHAR(16) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT publish_audit_to_status CHECK (to_status IN ('draft', 'published', 'archived')),
  CONSTRAINT publish_audit_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id),
  CONSTRAINT publish_audit_item_fk FOREIGN KEY (item_id) REFERENCES items (id)
);

CREATE TABLE IF NOT EXISTS library_access (
  library_id VARCHAR(36) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL,
  granted_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (library_id, subject),
  CONSTRAINT library_access_role_known CHECK (role IN ('reader', 'publisher')),
  CONSTRAINT library_access_library_fk FOREIGN KEY (library_id) REFERENCES libraries (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS records_updated_at ON records (updated_at);
CREATE INDEX IF NOT EXISTS records_library_id ON records (library_id);
CREATE INDEX IF NOT EXISTS libraries_updated_at ON libraries (updated_at);
CREATE INDEX IF NOT EXISTS libraries_name_lower ON libraries (LOWER(name));
CREATE INDEX IF NOT EXISTS audit_created_at ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS items_library_status_updated ON items (library_id, status, updated_at);
CREATE INDEX IF NOT EXISTS items_labels_gin ON items USING GIN (labels);
CREATE INDEX IF NOT EXISTS items_name_trgm ON items USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_summary_trgm ON items USING GIN (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS publish_audit_library_created ON publish_audit (library_id, created_at);
CREATE INDEX IF NOT EXISTS library_access_subject ON library_access (subject);

-- Search document for name/summary/body (weighted in queries via ts_rank).
ALTER TABLE items ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS items_search_tsv ON items USING GIN (search_tsv);

-- Default library when the database is empty (stable Main id for local/dev).
INSERT INTO libraries (id, name, template, created_by, updated_by, created_at, updated_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Main',
  'general',
  'system',
  'system',
  (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
WHERE NOT EXISTS (SELECT 1 FROM libraries);
