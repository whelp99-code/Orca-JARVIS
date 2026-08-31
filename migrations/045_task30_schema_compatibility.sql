-- Task 30 additive compatibility: retain the frozen deletion lane beside proof-bound effects.
DROP TRIGGER memory_deletion_initial_state;
DROP TRIGGER memory_deletion_identity;
DROP TRIGGER memory_deletion_transition;
DROP TRIGGER memory_deletion_suppression_guard;
DROP TRIGGER memory_deletion_one_send;
DROP TRIGGER memory_deletion_settlement;
DROP INDEX memory_deletion_state;
DROP INDEX memory_deletion_subject;
ALTER TABLE memory_deletion_requests RENAME TO memory_deletion_effect_requests;

CREATE INDEX memory_deletion_effect_state
  ON memory_deletion_effect_requests(state,updated_at,deletion_id);
CREATE INDEX memory_deletion_effect_subject
  ON memory_deletion_effect_requests(keyed_subject_digest,created_at,deletion_id);

CREATE TRIGGER memory_deletion_effect_initial
BEFORE INSERT ON memory_deletion_effect_requests
WHEN NEW.state<>'requested' OR NEW.dispatch_fence<>0
BEGIN SELECT RAISE(ABORT,'memory deletion must start requested'); END;
CREATE TRIGGER memory_deletion_effect_identity
BEFORE UPDATE OF deletion_id,lane_id,correlation_id,idempotency_key,provider_instance_id,
  operation,keyed_subject_digest,scope_digest,target_manifest_digest,payload_digest,
  requested_by,expires_at,created_at ON memory_deletion_effect_requests
WHEN OLD.state<>'requested'
BEGIN SELECT RAISE(ABORT,'immutable memory deletion identity'); END;
CREATE TRIGGER memory_deletion_effect_transition
BEFORE UPDATE OF state ON memory_deletion_effect_requests
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'requested:approved','approved:suppressed','suppressed:queued','queued:applying',
  'applying:reconciling','reconciling:provider_proved','provider_proved:settled'
)
BEGIN SELECT RAISE(ABORT,'memory deletion transition invalid'); END;
CREATE TRIGGER memory_deletion_effect_suppression_guard
BEFORE UPDATE OF state ON memory_deletion_effect_requests
WHEN NEW.state='suppressed' AND (
  NEW.tombstone_sequence IS NULL OR NEW.tombstone_set_root IS NULL OR NOT EXISTS (
    SELECT 1 FROM memory_tombstone_chain t
    JOIN memory_suppressions s ON s.sequence=t.sequence
    WHERE t.sequence=NEW.tombstone_sequence AND t.operation='forget'
      AND t.scope_digest=NEW.scope_digest
      AND t.target_manifest_digest=NEW.target_manifest_digest
      AND t.set_root=NEW.tombstone_set_root
  )
)
BEGIN SELECT RAISE(ABORT,'memory deletion suppression required'); END;
CREATE TRIGGER memory_deletion_effect_one_send
BEFORE UPDATE OF dispatch_fence ON memory_deletion_effect_requests
WHEN NEW.dispatch_fence<>OLD.dispatch_fence AND NOT (
  OLD.dispatch_fence=0 AND NEW.dispatch_fence=1
  AND OLD.state='queued' AND NEW.state='applying'
)
BEGIN SELECT RAISE(ABORT,'memory deletion dispatch already spent'); END;
CREATE TRIGGER memory_deletion_effect_settlement
BEFORE UPDATE OF state ON memory_deletion_effect_requests
WHEN NEW.state='settled' AND (
  NEW.provider_proof_digest IS NULL OR NEW.surface_manifest_digest IS NULL
  OR NEW.purge_receipt_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM memory_deletion_proofs p
    WHERE p.deletion_id=OLD.deletion_id
      AND p.proof_digest=NEW.provider_proof_digest
      AND p.surface_manifest_digest=NEW.surface_manifest_digest
      AND p.purge_receipt_digest=NEW.purge_receipt_digest
  )
)
BEGIN SELECT RAISE(ABORT,'memory deletion provider proof required'); END;

DELETE FROM memory_deletion_effect_requests
WHERE deletion_id IN (SELECT deletion_id FROM _task30_legacy_deletion_requests_snapshot);

CREATE TABLE memory_deletion_requests (
  deletion_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK(operation='forget'),
  subject_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by='local-owner'),
  state TEXT NOT NULL CHECK(state IN (
    'requested','approved','queued','applying','tombstoned','settled',
    'rejected','expired','failed','uncertain'
  )),
  confirmation_request_id TEXT REFERENCES control_command_requests(request_id),
  confirmation_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  confirmation_receipt_digest TEXT,
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK((confirmation_request_id IS NULL AND confirmation_receipt_id IS NULL
    AND confirmation_receipt_digest IS NULL) OR (
    confirmation_request_id IS NOT NULL AND confirmation_receipt_id IS NOT NULL
    AND confirmation_receipt_digest IS NOT NULL
  )),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (
    lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0
  )),
  CHECK(state<>'applying' OR lease_owner IS NOT NULL)
);
CREATE INDEX memory_deletion_state
  ON memory_deletion_requests(state,expires_at,deletion_id);
CREATE INDEX memory_deletion_subject
  ON memory_deletion_requests(subject_digest,created_at,deletion_id);
INSERT INTO memory_deletion_requests
SELECT * FROM _task30_legacy_deletion_requests_snapshot;

DROP VIEW memory_tombstones;
CREATE TABLE memory_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL UNIQUE REFERENCES memory_deletion_requests(deletion_id),
  subject_digest TEXT NOT NULL UNIQUE,
  scope_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  approval_request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  approval_receipt_id TEXT NOT NULL REFERENCES control_command_receipts(receipt_id),
  approval_receipt_digest TEXT NOT NULL,
  effect_lease_owner TEXT NOT NULL,
  effect_lease_fence INTEGER NOT NULL CHECK(effect_lease_fence>0),
  effective_at TEXT NOT NULL,
  tombstone_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_tombstones_effective
  ON memory_tombstones(effective_at,tombstone_id);
INSERT INTO memory_tombstones
SELECT * FROM _task30_legacy_tombstones_snapshot;


DROP TABLE _task30_legacy_tombstones_snapshot;
DROP TABLE _task30_legacy_deletion_requests_snapshot;
