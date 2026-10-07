-- Super Admin (sa) replaces the old edit account role.
-- disabled stops sign-in without deleting the account or access grants.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;

UPDATE accounts SET role = 'sa' WHERE role = 'edit';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_role_check CHECK (role IN ('sa', 'readonly'));
