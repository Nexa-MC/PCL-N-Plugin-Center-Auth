ALTER TABLE external_connections ADD COLUMN ownership_verified_at TEXT;
ALTER TABLE external_connections ADD COLUMN profile_source TEXT;
ALTER TABLE external_connections ADD COLUMN profile_attempted_at INTEGER;
ALTER TABLE external_connections ADD COLUMN profile_error INTEGER NOT NULL DEFAULT 0 CHECK(profile_error IN (0,1));

-- Only migrate bindings with a matching successful ownership challenge.
UPDATE external_connections SET ownership_verified_at=connected_at,profile_source='cloudflare-browser'
WHERE provider='bilibili' AND EXISTS(
  SELECT 1 FROM bilibili_binding_challenges c WHERE c.user_id=external_connections.user_id
    AND c.uid=external_connections.subject AND c.state='verified' AND c.verified_at=external_connections.connected_at
);

CREATE TABLE github_contributor_snapshots(
  repository TEXT PRIMARY KEY,
  contributors_json TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT,
  attempted_at INTEGER,
  error INTEGER NOT NULL DEFAULT 0 CHECK(error IN (0,1))
);
