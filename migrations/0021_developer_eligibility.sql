ALTER TABLE oauth_states ADD COLUMN developer_check INTEGER NOT NULL DEFAULT 0 CHECK(developer_check IN (0,1));
CREATE TABLE github_developer_profiles(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  account_created_at TEXT NOT NULL,
  followers INTEGER NOT NULL CHECK(followers>=0),
  qualifying_repository TEXT,
  org_member INTEGER NOT NULL CHECK(org_member IN (0,1)),
  checked_at TEXT NOT NULL,
  core_verified_at TEXT,
  core_reviewer TEXT
);
ALTER TABLE applications ADD COLUMN core_contributor_claimed INTEGER NOT NULL DEFAULT 0 CHECK(core_contributor_claimed IN (0,1));
ALTER TABLE applications ADD COLUMN github_subject TEXT;
ALTER TABLE applications ADD COLUMN github_linked_at TEXT;
UPDATE applications SET state='rejected',note='申请条件已更新，请按新条件重新申请',reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),reviewer='system:criteria-update'
WHERE state='pending' AND kind IN ('developer','trusted_developer');
