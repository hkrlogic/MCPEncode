-- Baseline tables.
-- CREATE IF NOT EXISTS so a fresh database and an older one both apply.
-- records is the notes-style table. Later migrations copy it; they do not drop it.
--
-- MariaDB / InnoDB. utf8mb4_unicode_ci is case-insensitive, which is what
-- SQLite COLLATE NOCASE used to do for names.
-- Ids we generate are UUIDs (36 characters). created_by is an OAuth subject,
-- which can be longer than a UUID. Times are Unix milliseconds.

CREATE TABLE IF NOT EXISTS libraries (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS records (
  id VARCHAR(36) NOT NULL,
  library_id VARCHAR(36) NOT NULL DEFAULT '',
  title VARCHAR(200) NOT NULL,
  notes MEDIUMTEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT ('[]'),
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(36) NOT NULL,
  actor_sub VARCHAR(255) NOT NULL,
  tool VARCHAR(64) NOT NULL,
  success TINYINT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS records_updated_at ON records (updated_at);
CREATE INDEX IF NOT EXISTS libraries_updated_at ON libraries (updated_at);
CREATE INDEX IF NOT EXISTS audit_created_at ON audit_events (created_at);
