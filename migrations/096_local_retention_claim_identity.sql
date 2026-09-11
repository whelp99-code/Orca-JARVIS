-- The identity of a directory a run actually created, recorded once it exists.
--
-- The intent alone says a process meant to create a path. That is not evidence that the object now
-- at that path is the one it created, and a recovery that deletes on the strength of the intent
-- deletes whatever happens to be there. The identity is written immediately after the exclusive
-- create succeeds, and recovery removes only what still carries it.
--
-- Nullable because the row exists before the directory does: a crash in that window leaves an
-- intent with no identity, which is precisely the case that must not be deleted.
ALTER TABLE local_retention_claim_intents ADD COLUMN claim_device TEXT;
ALTER TABLE local_retention_claim_intents ADD COLUMN claim_inode TEXT;
ALTER TABLE local_retention_claim_intents ADD COLUMN claim_birthtime TEXT;

-- Written once, when it is first learned. A second write would let a later run point an existing
-- intent at a different object.
CREATE TRIGGER local_retention_claim_intents_identity_once BEFORE UPDATE
  OF claim_device,claim_inode,claim_birthtime,operation_id,owner_token,directory
  ON local_retention_claim_intents
WHEN NOT (OLD.claim_device IS NULL AND NEW.claim_device IS NOT NULL
  AND OLD.operation_id=NEW.operation_id AND OLD.owner_token=NEW.owner_token
  AND OLD.directory=NEW.directory)
BEGIN SELECT RAISE(ABORT,'immutable retention claim intent'); END;
