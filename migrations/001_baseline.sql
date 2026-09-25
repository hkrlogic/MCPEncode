-- Baseline tables already used by the POC.
-- CREATE IF NOT EXISTS so a fresh file and an existing POC file both apply.
-- records is the notes-style table. Later migrations copy it; they do not drop it.

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_sub TEXT NOT NULL,
  tool TEXT NOT NULL,
  success INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS records_updated_at ON records (updated_at DESC);
CREATE INDEX IF NOT EXISTS libraries_updated_at ON libraries (updated_at DESC);
CREATE INDEX IF NOT EXISTS audit_created_at ON audit_events (created_at DESC);
