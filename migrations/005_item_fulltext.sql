-- Full-text indexes for library lookups.
-- MariaDB uses these to find whole words. A lookup no longer reads every body.
-- Words shorter than innodb_ft_min_token_size (3) are not in the index.
-- Those still match against the name and summary in the query code.
-- This file does not drop any table.

CREATE FULLTEXT INDEX IF NOT EXISTS items_name_summary ON items (name, summary);
CREATE FULLTEXT INDEX IF NOT EXISTS items_body ON items (body);
