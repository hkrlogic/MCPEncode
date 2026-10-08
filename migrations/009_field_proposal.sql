-- One optional field waiting for a publisher to Approve in the portal.
-- Approve appends it to libraries.schema.fields and clears this column.
-- Agents propose only; they cannot approve or reject.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS field_proposal JSONB;
