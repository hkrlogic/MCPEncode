-- A shelf is a bonded search across libraries. It does not grant Access.
-- One library sits on at most one shelf. Deleting a shelf leaves the libraries in place.

CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS shelf_id TEXT REFERENCES shelves (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS libraries_shelf_id_idx ON libraries (shelf_id);
