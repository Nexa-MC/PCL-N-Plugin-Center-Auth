ALTER TABLE account_deletion_requests ADD COLUMN publisher_forfeit_consent TEXT;
CREATE TRIGGER deletion_consent_immutable BEFORE UPDATE OF publisher_forfeit_consent ON account_deletion_requests
 WHEN NEW.publisher_forfeit_consent IS NOT OLD.publisher_forfeit_consent BEGIN SELECT RAISE(ABORT,'deletion_consent_immutable'); END;
