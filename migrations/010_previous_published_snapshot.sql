-- One prior published copy so Revert still works after Publish (or Unlock save)
-- replaces published_snapshot. Not full history — only the previous seal.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS previous_published_snapshot TEXT NULL;
