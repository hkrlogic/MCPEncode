-- Library type. Existing libraries stay "general".
-- Policy items store Owner, Effective date, and Rule in details (JSON)
-- and the same labels in body so an agent can read them.
-- This file does not drop any table.

ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS template VARCHAR(32) NOT NULL DEFAULT 'general';

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS details TEXT NULL;
