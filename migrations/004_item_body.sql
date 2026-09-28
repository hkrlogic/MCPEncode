-- Rename items.data → body (product vocabulary: name, labels, summary, body).
-- Applied once. Safe to skip when body already exists (see migrate.ts).
-- Does not touch the frozen records table.

ALTER TABLE items RENAME COLUMN data TO body;
