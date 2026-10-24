-- Independent sequence/epoch: these are not auth_audit IDs or wallet entries.
ALTER TABLE account_deletion_requests ADD COLUMN finalization_token TEXT;
CREATE TABLE account_lifecycle_source (
 id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL UNIQUE CHECK(length(epoch)=32)
);
INSERT INTO account_lifecycle_source(id,epoch) VALUES(1,lower(hex(randomblob(16))));
CREATE TABLE account_lifecycle_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','disabled','deleted')), occurred_at TEXT NOT NULL
);
CREATE INDEX account_lifecycle_outbox_user ON account_lifecycle_outbox(user_id,sequence);
CREATE TABLE account_lifecycle_current (
 user_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL REFERENCES account_lifecycle_outbox(sequence),
 state TEXT NOT NULL CHECK(state IN ('active','disabled','deleted')), occurred_at TEXT NOT NULL
);
INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at)
 SELECT u.id,CASE WHEN t.subject_id IS NOT NULL THEN 'deleted' WHEN u.disabled=1 THEN 'disabled' ELSE 'active' END,
 COALESCE(t.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM users u LEFT JOIN deletion_tombstones t ON t.subject_id=u.id
 WHERE u.id!='system:ghost' ORDER BY u.id;
INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at)
 SELECT t.subject_id,'deleted',t.deleted_at FROM deletion_tombstones t WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=t.subject_id) ORDER BY t.subject_id;
INSERT INTO account_lifecycle_current(user_id,sequence,state,occurred_at)
 SELECT user_id,sequence,state,occurred_at FROM account_lifecycle_outbox;

CREATE TRIGGER account_lifecycle_materialize AFTER INSERT ON account_lifecycle_outbox BEGIN
 INSERT INTO account_lifecycle_current(user_id,sequence,state,occurred_at) VALUES(NEW.user_id,NEW.sequence,NEW.state,NEW.occurred_at)
 ON CONFLICT(user_id) DO UPDATE SET sequence=excluded.sequence,state=excluded.state,occurred_at=excluded.occurred_at
 WHERE account_lifecycle_current.state!='deleted' OR excluded.state='deleted';
END;
CREATE TRIGGER account_lifecycle_created AFTER INSERT ON users WHEN NEW.id!='system:ghost' BEGIN
 INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at) VALUES(NEW.id,
 CASE WHEN EXISTS(SELECT 1 FROM deletion_tombstones WHERE subject_id=NEW.id) THEN 'deleted' WHEN NEW.disabled=1 THEN 'disabled' ELSE 'active' END,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER account_lifecycle_disabled AFTER UPDATE OF disabled ON users WHEN NEW.id!='system:ghost' AND NEW.disabled!=OLD.disabled BEGIN
 INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at) VALUES(NEW.id,
 CASE WHEN EXISTS(SELECT 1 FROM deletion_tombstones WHERE subject_id=NEW.id) THEN 'deleted' WHEN NEW.disabled=1 THEN 'disabled' ELSE 'active' END,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER account_lifecycle_removed AFTER DELETE ON users WHEN OLD.id!='system:ghost' BEGIN
 INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at) VALUES(OLD.id,'deleted',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER account_lifecycle_deleted AFTER INSERT ON deletion_tombstones BEGIN
 INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at) VALUES(NEW.subject_id,'deleted',NEW.deleted_at);
END;
CREATE TRIGGER account_lifecycle_deleted_updated AFTER UPDATE ON deletion_tombstones BEGIN
 INSERT INTO account_lifecycle_outbox(user_id,state,occurred_at) VALUES(NEW.subject_id,'deleted',NEW.deleted_at);
END;
CREATE TRIGGER account_lifecycle_outbox_immutable BEFORE UPDATE ON account_lifecycle_outbox BEGIN SELECT RAISE(ABORT,'account_lifecycle_immutable'); END;
CREATE TRIGGER account_lifecycle_outbox_no_delete BEFORE DELETE ON account_lifecycle_outbox BEGIN SELECT RAISE(ABORT,'account_lifecycle_immutable'); END;
CREATE TRIGGER account_lifecycle_current_no_delete BEFORE DELETE ON account_lifecycle_current BEGIN SELECT RAISE(ABORT,'account_lifecycle_immutable'); END;
CREATE TRIGGER account_lifecycle_epoch_immutable BEFORE UPDATE ON account_lifecycle_source BEGIN SELECT RAISE(ABORT,'account_lifecycle_immutable'); END;
CREATE TRIGGER account_lifecycle_epoch_no_delete BEFORE DELETE ON account_lifecycle_source BEGIN SELECT RAISE(ABORT,'account_lifecycle_immutable'); END;
