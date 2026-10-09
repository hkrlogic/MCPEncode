-- Files on an item (PDF and images). Bytes stay in Postgres with the item.
-- Deleting the item removes its files. Readers only reach files through the item's publish gate.
CREATE TABLE IF NOT EXISTS item_files (
  id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  content_type VARCHAR(80) NOT NULL,
  byte_size INTEGER NOT NULL,
  bytes BYTEA NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT item_files_item_fk FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT item_files_size CHECK (byte_size > 0 AND byte_size <= 10485760),
  CONSTRAINT item_files_type CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp'))
);

CREATE INDEX IF NOT EXISTS item_files_item ON item_files (item_id, created_at);
