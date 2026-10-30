ALTER TABLE users ADD COLUMN bound_email_at TEXT;
CREATE TABLE verified_account_emails(email TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id));
CREATE TABLE account_email_challenges(challenge_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),target_email TEXT NOT NULL,expected_email TEXT,new_mac TEXT NOT NULL,old_mac TEXT,attempts INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,verified_at TEXT);
CREATE INDEX account_email_challenge_expiry ON account_email_challenges(expires);
CREATE TRIGGER account_email_bind_apply AFTER UPDATE OF consumed ON account_email_challenges WHEN OLD.consumed=0 AND NEW.consumed=1 AND NEW.verified=1 BEGIN
 SELECT CASE WHEN NEW.expires<=unixepoch()*1000 OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND disabled=0 AND confirmed_at IS NOT NULL AND lower(email) IS NEW.expected_email)
 OR EXISTS(SELECT 1 FROM users WHERE id!=NEW.user_id AND lower(email)=NEW.target_email)
 THEN RAISE(ABORT,'email_binding_conflict') END;
 DELETE FROM verified_account_emails WHERE user_id=NEW.user_id;
 INSERT INTO verified_account_emails(email,user_id) VALUES(NEW.target_email,NEW.user_id);
 UPDATE users SET email=NEW.target_email,bound_email_at=NEW.verified_at WHERE id=NEW.user_id;
 INSERT INTO auth_audit(actor,action,detail,created_at) VALUES(NEW.user_id,'account.email.bound',NULL,NEW.verified_at);
END;
CREATE TRIGGER account_verified_email_insert BEFORE INSERT ON users WHEN NEW.email IS NOT NULL AND EXISTS(SELECT 1 FROM verified_account_emails WHERE email=lower(NEW.email) AND user_id!=NEW.id) BEGIN SELECT RAISE(ABORT,'email_binding_conflict'); END;
CREATE TRIGGER account_verified_email_update BEFORE UPDATE OF email ON users WHEN NEW.email IS NOT NULL AND EXISTS(SELECT 1 FROM verified_account_emails WHERE email=lower(NEW.email) AND user_id!=NEW.id) BEGIN SELECT RAISE(ABORT,'email_binding_conflict'); END;
CREATE TRIGGER account_email_delete_cleanup AFTER UPDATE OF email ON users WHEN NEW.email IS NULL BEGIN DELETE FROM verified_account_emails WHERE user_id=NEW.id; END;
