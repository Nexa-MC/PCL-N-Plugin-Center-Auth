ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'web' CHECK(client IN ('web','nexacl'));
CREATE TABLE device_authorizations(
 device_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL,
 next_poll INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE, approved_session TEXT
);
CREATE INDEX device_authorizations_expiry ON device_authorizations(expires);
