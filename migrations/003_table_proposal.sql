-- A table an agent proposed for one library. Null means nothing is waiting.
-- Approve copies the columns onto libraries.schema and clears this column.
-- Reject clears it. There is no MCP tool that approves or rejects.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS table_proposal JSONB;
