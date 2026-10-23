-- Revoke the initial plain-code challenges before switching the signature format.
UPDATE bilibili_binding_challenges SET state='revoked' WHERE state='pending';
ALTER TABLE bilibili_binding_challenges ADD COLUMN encoder_version TEXT;
ALTER TABLE bilibili_binding_challenges ADD COLUMN nonce_hash TEXT;
ALTER TABLE bilibili_binding_challenges ADD COLUMN selected_index INTEGER CHECK(selected_index IS NULL OR selected_index BETWEEN 0 AND 3);
CREATE UNIQUE INDEX bilibili_nonce_uniqueness ON bilibili_binding_challenges(nonce_hash) WHERE nonce_hash IS NOT NULL;
CREATE TABLE bilibili_signature_candidates(
  challenge_id TEXT NOT NULL REFERENCES bilibili_binding_challenges(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL CHECK(candidate_index BETWEEN 0 AND 3),
  expected_hash TEXT NOT NULL,
  PRIMARY KEY(challenge_id,candidate_index)
);
ALTER TABLE external_connections ADD COLUMN avatar_url TEXT;
