ALTER TABLE users ADD COLUMN creator INTEGER NOT NULL DEFAULT 0 CHECK(creator IN (0,1));

CREATE TABLE applications_with_creator(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('creator','developer','trusted_developer','admin')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
  note TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer TEXT,
  core_contributor_claimed INTEGER NOT NULL DEFAULT 0 CHECK(core_contributor_claimed IN (0,1)),
  github_subject TEXT,
  github_linked_at TEXT
);
INSERT INTO applications_with_creator(id,user_id,kind,state,note,created_at,reviewed_at,reviewer,core_contributor_claimed,github_subject,github_linked_at)
SELECT id,user_id,kind,state,note,created_at,reviewed_at,reviewer,core_contributor_claimed,github_subject,github_linked_at FROM applications;
DROP TABLE applications;
ALTER TABLE applications_with_creator RENAME TO applications;
CREATE UNIQUE INDEX one_pending_application ON applications(user_id,kind) WHERE state='pending';
CREATE INDEX applications_state ON applications(state,created_at);
