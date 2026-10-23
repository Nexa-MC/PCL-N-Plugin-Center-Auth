CREATE TABLE bilibili_binding_challenges(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  uid TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','revoked','verified')),
  verified_at TEXT
);
CREATE UNIQUE INDEX bilibili_one_pending_challenge ON bilibili_binding_challenges(user_id) WHERE state='pending';
CREATE INDEX bilibili_challenge_retention ON bilibili_binding_challenges(expires_at);
ALTER TABLE external_connections ADD COLUMN profile_level INTEGER CHECK(profile_level IS NULL OR profile_level BETWEEN 0 AND 6);
CREATE TABLE bilibili_provider_state(id INTEGER PRIMARY KEY CHECK(id=1),blocked_until INTEGER NOT NULL DEFAULT 0);
