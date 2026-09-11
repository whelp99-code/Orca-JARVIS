-- The verified digest is written once, when the operation becomes verified.
--
-- It exists to say which bytes were proved correct, so a row that can be rewritten afterwards
-- proves nothing: anyone able to update it could point a verified operation at a candidate it
-- never checked. The identity trigger added in 092 does not cover this column because it is
-- written after the row is created, which is exactly why it needs its own rule.
CREATE TRIGGER local_retention_operations_verified_digest_once BEFORE UPDATE OF verified_digest
  ON local_retention_operations
WHEN NOT (OLD.verified_digest IS NULL AND NEW.verified_digest IS NOT NULL
  AND OLD.state='preparing' AND NEW.state='verified')
BEGIN SELECT RAISE(ABORT,'retention verified digest is written once'); END;
