-- Core5 J03: persist operation_id / attempt_id / lease_fence / approval digest.
-- Same approved operation must not schedule duplicate external side effects on a new lease.
CREATE TABLE core5_integration_operations (
  operation_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  lease_fence TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'scheduled',
    'SUCCESS',
    'FAIL',
    'TIMEOUT',
    'UNCERTAIN',
    'CANCELLED',
    'CANCELLED_AFTER_POSSIBLE_EFFECT'
  )),
  created_at TEXT NOT NULL
);

CREATE TRIGGER core5_integration_no_duplicate_lease BEFORE UPDATE OF lease_fence
  ON core5_integration_operations
WHEN OLD.lease_fence != NEW.lease_fence AND OLD.outcome IN ('scheduled','SUCCESS')
BEGIN SELECT RAISE(ABORT,'CORE5_DUPLICATE_SIDE_EFFECT'); END;
