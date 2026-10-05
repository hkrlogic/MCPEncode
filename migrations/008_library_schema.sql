-- Per-library field schema (definitions) and typed value rows (data).
-- Schema JSON is the contract. Values live in item_field_values, not Markdown.
-- Does not drop any table.

CREATE TABLE IF NOT EXISTS library_schemas (
  library_id VARCHAR(36) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  fields_json MEDIUMTEXT NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (library_id, version),
  CONSTRAINT library_schemas_status_known CHECK (status IN ('draft', 'published')),
  CONSTRAINT library_schemas_library_fk
    FOREIGN KEY (library_id) REFERENCES libraries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS library_schemas_library_status
  ON library_schemas (library_id, status, version);

CREATE TABLE IF NOT EXISTS item_field_values (
  item_id VARCHAR(36) NOT NULL,
  field_key VARCHAR(64) NOT NULL,
  value_string VARCHAR(2000) NULL,
  value_number DOUBLE NULL,
  value_date DATE NULL,
  value_boolean TINYINT(1) NULL,
  PRIMARY KEY (item_id, field_key),
  CONSTRAINT item_field_values_item_fk
    FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Prefix on value_string: utf8mb4 full 2000-char index exceeds InnoDB key length.
CREATE INDEX IF NOT EXISTS item_field_values_key_string
  ON item_field_values (field_key, value_string(191));
CREATE INDEX IF NOT EXISTS item_field_values_key_number
  ON item_field_values (field_key, value_number);
CREATE INDEX IF NOT EXISTS item_field_values_key_date
  ON item_field_values (field_key, value_date);
