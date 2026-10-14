-- Settings → Apps: a host a site admin revoked (after approving it) is listed
-- as Revoked, not Denied. Both refuse sign-in the same way.
ALTER TABLE callback_hosts DROP CONSTRAINT IF EXISTS callback_hosts_status_check;
ALTER TABLE callback_hosts
  ADD CONSTRAINT callback_hosts_status_check CHECK (status IN ('pending', 'approved', 'denied', 'revoked'));
