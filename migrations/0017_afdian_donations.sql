-- Only successful, complete order queries for the currently linked account count.
-- Historical manual donor verifications remain in the audit trail, but do not grant this badge.
ALTER TABLE external_connections ADD COLUMN donation_cents INTEGER CHECK(donation_cents IS NULL OR donation_cents >= 0);
ALTER TABLE external_connections ADD COLUMN donation_checked_at TEXT;
ALTER TABLE external_connections ADD COLUMN donation_attempted_at INTEGER;
ALTER TABLE external_connections ADD COLUMN donation_error INTEGER NOT NULL DEFAULT 0 CHECK(donation_error IN (0,1));
