-- The live deletion lane is memory_deletion_effect_requests: 042 created it as
-- memory_deletion_requests, and 045 renamed it. Its CHECK admits no conflict, so
-- a provider refusal cannot end the lane. Rebuild the lane and the tables whose
-- foreign keys name it, adding reconciling:conflict as 041 does for corrections.
-- Existing rows are copied unchanged. Shipped migration bytes are not edited.
DROP TRIGGER memory_deletion_effect_initial;
DROP TRIGGER memory_deletion_effect_identity;
DROP TRIGGER memory_deletion_effect_transition;
DROP TRIGGER memory_deletion_effect_suppression_guard;
DROP TRIGGER memory_deletion_effect_one_send;
DROP TRIGGER memory_deletion_effect_settlement;
DROP TRIGGER memory_deletion_attempt_immutable_update;
DROP TRIGGER memory_deletion_attempt_immutable_delete;
DROP TRIGGER memory_deletion_event_immutable_update;
DROP TRIGGER memory_deletion_event_immutable_delete;
DROP TRIGGER memory_deletion_proof_immutable_delete;
DROP INDEX memory_deletion_effect_state;
DROP INDEX memory_deletion_effect_subject;

ALTER TABLE memory_deletion_attempts RENAME TO memory_deletion_attempts_v2;
ALTER TABLE memory_deletion_events RENAME TO memory_deletion_events_v2;
ALTER TABLE memory_deletion_proofs RENAME TO memory_deletion_proofs_v2;
ALTER TABLE memory_deletion_effect_requests RENAME TO memory_deletion_effect_requests_v2;

CREATE TABLE memory_deletion_effect_requests (
  deletion_id TEXT PRIMARY KEY,
  lane_id TEXT UNIQUE,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT,
  operation TEXT NOT NULL CHECK(operation='forget'),
  keyed_subject_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by='principal:owner'),
  state TEXT NOT NULL CHECK(state IN (
    'requested','approved','suppressed','queued','applying','reconciling',
    'provider_proved','settled','conflict'
  )),
  control_request_id TEXT UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  control_command_digest TEXT,
  tombstone_sequence INTEGER UNIQUE REFERENCES memory_tombstone_chain(sequence),
  tombstone_set_root TEXT,
  request_id TEXT UNIQUE,
  request_digest TEXT UNIQUE,
  envelope_digest TEXT UNIQUE,
  provider_idempotency_key TEXT UNIQUE,
  delegation_id TEXT UNIQUE,
  delegation_digest TEXT UNIQUE,
  spool_locator TEXT,
  spool_digest TEXT,
  dispatch_fence INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_fence>=0),
  dispatched_at TEXT,
  reconcile_deadline_at TEXT,
  provider_proof_digest TEXT UNIQUE,
  surface_manifest_digest TEXT,
  purge_receipt_digest TEXT UNIQUE,
  failure_code TEXT,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(failure_code='REAPPROVAL_REQUIRED' OR state IN ('requested','approved') OR (tombstone_sequence IS NOT NULL AND tombstone_set_root IS NOT NULL)),
  CHECK(failure_code='REAPPROVAL_REQUIRED' OR state IN ('requested','approved','suppressed') OR request_id IS NOT NULL)
);
CREATE INDEX memory_deletion_effect_state
  ON memory_deletion_effect_requests(state,updated_at,deletion_id);
CREATE INDEX memory_deletion_effect_subject
  ON memory_deletion_effect_requests(keyed_subject_digest,created_at,deletion_id);
INSERT INTO memory_deletion_effect_requests
SELECT * FROM memory_deletion_effect_requests_v2;

CREATE TABLE memory_deletion_attempts (
  attempt_id TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL UNIQUE REFERENCES memory_deletion_effect_requests(deletion_id),
  dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence=1),
  invocation_digest TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK(outcome IN ('dispatching','accepted','uncertain')),
  acceptance_digest TEXT UNIQUE,
  queue_locator_digest TEXT,
  outcome_code TEXT,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO memory_deletion_attempts SELECT * FROM memory_deletion_attempts_v2;

CREATE TABLE memory_deletion_events (
  event_id TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL REFERENCES memory_deletion_effect_requests(deletion_id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'requested','approved','suppressed','queued','applying','accepted','uncertain',
    'reconciling','provider_proved','purged','settled','conflict','timeout'
  )),
  event_digest TEXT NOT NULL UNIQUE,
  proof_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(deletion_id,sequence)
);
INSERT INTO memory_deletion_events SELECT * FROM memory_deletion_events_v2;

CREATE TABLE memory_deletion_proofs (
  deletion_id TEXT PRIMARY KEY REFERENCES memory_deletion_effect_requests(deletion_id),
  proof_id TEXT NOT NULL UNIQUE,
  proof_digest TEXT NOT NULL UNIQUE,
  provider_release_sha TEXT NOT NULL,
  result_generation_id TEXT NOT NULL,
  surface_manifest_digest TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  purge_receipt_digest TEXT,
  settled_at TEXT
);
INSERT INTO memory_deletion_proofs SELECT * FROM memory_deletion_proofs_v2;

DROP TABLE memory_deletion_attempts_v2;
DROP TABLE memory_deletion_events_v2;
DROP TABLE memory_deletion_proofs_v2;
DROP TABLE memory_deletion_effect_requests_v2;

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
  'applying:reconciling','reconciling:provider_proved','reconciling:conflict',
  'provider_proved:settled'
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
CREATE TRIGGER memory_deletion_attempt_immutable_update
BEFORE UPDATE OF attempt_id,deletion_id,dispatch_fence,invocation_digest,dispatched_at,created_at
  ON memory_deletion_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory deletion attempt'); END;
CREATE TRIGGER memory_deletion_attempt_immutable_delete
BEFORE DELETE ON memory_deletion_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory deletion attempt'); END;
CREATE TRIGGER memory_deletion_event_immutable_update
BEFORE UPDATE ON memory_deletion_events
BEGIN SELECT RAISE(ABORT,'immutable memory deletion event'); END;
CREATE TRIGGER memory_deletion_event_immutable_delete
BEFORE DELETE ON memory_deletion_events
BEGIN SELECT RAISE(ABORT,'immutable memory deletion event'); END;
CREATE TRIGGER memory_deletion_proof_immutable_delete
BEFORE DELETE ON memory_deletion_proofs
BEGIN SELECT RAISE(ABORT,'immutable memory deletion proof'); END;
