-- Task 30 dedicated exact-scope export saga.
CREATE TABLE memory_export_requests (
  export_id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation='export'),
  scope_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by='principal:owner'),
  state TEXT NOT NULL CHECK(state IN ('requested','approved','queued','writing','provider_proved','available','expired','invalidated')),
  control_request_id TEXT UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  control_command_digest TEXT,
  tombstone_sequence INTEGER NOT NULL,
  tombstone_set_root TEXT NOT NULL,
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
  provider_proof_digest TEXT UNIQUE,
  export_manifest_digest TEXT UNIQUE,
  export_file_count INTEGER,
  export_byte_count INTEGER,
  available_at TEXT,
  expires_at TEXT NOT NULL,
  artifact_expires_at TEXT,
  invalidated_at TEXT,
  invalidation_sequence INTEGER REFERENCES memory_tombstone_chain(sequence),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state IN ('requested','approved') OR request_id IS NOT NULL),
  CHECK(state<>'available' OR (provider_proof_digest IS NOT NULL AND export_manifest_digest IS NOT NULL AND available_at IS NOT NULL AND artifact_expires_at IS NOT NULL))
);
CREATE INDEX memory_export_state ON memory_export_requests(state,expires_at,export_id);
CREATE INDEX memory_export_scope ON memory_export_requests(scope_digest,state,export_id);
CREATE TABLE memory_export_attempts (
  attempt_id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL UNIQUE REFERENCES memory_export_requests(export_id),
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
CREATE TABLE memory_export_events (
  event_id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES memory_export_requests(export_id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('requested','approved','queued','writing','accepted','uncertain','provider_proved','available','expired','invalidated','timeout')),
  event_digest TEXT NOT NULL UNIQUE,
  proof_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(export_id,sequence)
);
CREATE TABLE memory_export_proofs (
  export_id TEXT PRIMARY KEY REFERENCES memory_export_requests(export_id),
  proof_id TEXT NOT NULL UNIQUE,
  proof_digest TEXT NOT NULL UNIQUE,
  provider_release_sha TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  export_manifest_digest TEXT NOT NULL UNIQUE,
  surface_manifest_digest TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  available_at TEXT,
  expired_at TEXT,
  invalidated_at TEXT
);
CREATE TABLE memory_export_target_digests (
  export_id TEXT NOT NULL REFERENCES memory_export_requests(export_id),
  target_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<64),
  PRIMARY KEY(export_id,target_digest),
  UNIQUE(export_id,ordinal)
);
CREATE TRIGGER memory_export_initial BEFORE INSERT ON memory_export_requests WHEN NEW.state<>'requested' OR NEW.dispatch_fence<>0 BEGIN SELECT RAISE(ABORT,'memory export must start requested'); END;
CREATE TRIGGER memory_export_identity BEFORE UPDATE OF export_id,lane_id,correlation_id,idempotency_key,provider_instance_id,operation,scope_digest,target_manifest_digest,payload_digest,requested_by,tombstone_sequence,tombstone_set_root,expires_at,created_at ON memory_export_requests WHEN OLD.state<>'requested' BEGIN SELECT RAISE(ABORT,'immutable memory export identity'); END;
CREATE TRIGGER memory_export_transition BEFORE UPDATE OF state ON memory_export_requests WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('requested:approved','approved:queued','queued:writing','writing:provider_proved','provider_proved:available','available:expired','available:invalidated') BEGIN SELECT RAISE(ABORT,'memory export transition invalid'); END;
CREATE TRIGGER memory_export_one_send BEFORE UPDATE OF dispatch_fence ON memory_export_requests WHEN NEW.dispatch_fence<>OLD.dispatch_fence AND NOT (OLD.dispatch_fence=0 AND NEW.dispatch_fence=1 AND OLD.state='queued' AND NEW.state='writing') BEGIN SELECT RAISE(ABORT,'memory export dispatch already spent'); END;
CREATE TRIGGER memory_export_available_guard BEFORE UPDATE OF state ON memory_export_requests WHEN NEW.state='available' AND NOT EXISTS (SELECT 1 FROM memory_export_proofs p WHERE p.export_id=OLD.export_id AND p.proof_digest=NEW.provider_proof_digest AND p.export_manifest_digest=NEW.export_manifest_digest) BEGIN SELECT RAISE(ABORT,'memory export provider proof required'); END;
CREATE TRIGGER memory_export_invalidation_guard BEFORE UPDATE OF state ON memory_export_requests WHEN NEW.state='invalidated' AND (NEW.invalidation_sequence IS NULL OR NOT EXISTS (SELECT 1 FROM memory_tombstone_chain t WHERE t.sequence=NEW.invalidation_sequence AND t.sequence>OLD.tombstone_sequence)) BEGIN SELECT RAISE(ABORT,'memory export tombstone invalidation required'); END;
CREATE TRIGGER memory_export_attempt_immutable_update BEFORE UPDATE OF attempt_id,export_id,dispatch_fence,invocation_digest,dispatched_at,created_at ON memory_export_attempts BEGIN SELECT RAISE(ABORT,'immutable memory export attempt'); END;
CREATE TRIGGER memory_export_attempt_immutable_delete BEFORE DELETE ON memory_export_attempts BEGIN SELECT RAISE(ABORT,'immutable memory export attempt'); END;
CREATE TRIGGER memory_export_event_immutable_update BEFORE UPDATE ON memory_export_events BEGIN SELECT RAISE(ABORT,'immutable memory export event'); END;
CREATE TRIGGER memory_export_event_immutable_delete BEFORE DELETE ON memory_export_events BEGIN SELECT RAISE(ABORT,'immutable memory export event'); END;
CREATE TRIGGER memory_export_target_immutable_update BEFORE UPDATE ON memory_export_target_digests BEGIN SELECT RAISE(ABORT,'immutable memory export target'); END;
CREATE TRIGGER memory_export_target_immutable_delete BEFORE DELETE ON memory_export_target_digests BEGIN SELECT RAISE(ABORT,'immutable memory export target'); END;
CREATE TRIGGER memory_export_proof_immutable_delete BEFORE DELETE ON memory_export_proofs BEGIN SELECT RAISE(ABORT,'immutable memory export proof'); END;
