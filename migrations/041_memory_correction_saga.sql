-- Task 30 correction-only V3 outbox closure and dedicated proof-bound saga.
DROP TRIGGER IF EXISTS memory_candidate_confirmation_guard;
DROP TRIGGER IF EXISTS memory_candidate_confirmation_redeem;
DROP TRIGGER IF EXISTS memory_outbox_v2_candidate_guard;
DROP TRIGGER IF EXISTS memory_outbox_v2_queue_candidate;
DROP TRIGGER IF EXISTS memory_outbox_v2_identity_immutable;
DROP TRIGGER IF EXISTS memory_outbox_v2_transition;
DROP TRIGGER IF EXISTS memory_outbox_v2_claim_guard;
DROP TRIGGER IF EXISTS memory_outbox_v2_active_lease;
DROP TRIGGER IF EXISTS memory_outbox_v2_dispatch_guard;
DROP TRIGGER IF EXISTS memory_outbox_v2_settlement_guard;
DROP TRIGGER IF EXISTS memory_outbox_v2_settlement_immutable;
DROP TRIGGER IF EXISTS memory_outbox_v2_attempt_insert;
DROP TRIGGER IF EXISTS memory_outbox_v2_attempt_identity;
DROP TRIGGER IF EXISTS memory_outbox_v2_attempt_transition;
DROP TRIGGER IF EXISTS memory_outbox_v2_attempt_delete;
DROP TRIGGER IF EXISTS memory_reconciliation_v2_fence;
DROP TRIGGER IF EXISTS memory_reconciliation_v2_immutable_update;
DROP TRIGGER IF EXISTS memory_reconciliation_v2_immutable_delete;
DROP TRIGGER IF EXISTS memory_outbox_v2_sync_candidate;

ALTER TABLE memory_reconciliation_events RENAME TO memory_reconciliation_events_v2;
ALTER TABLE memory_outbox_attempts RENAME TO memory_outbox_attempts_v2;
ALTER TABLE memory_outbox RENAME TO memory_outbox_v2;
DROP INDEX IF EXISTS memory_reconciliation_outbox;
DROP INDEX IF EXISTS memory_reconciliation_once;
DROP INDEX IF EXISTS memory_outbox_attempts_outbox;
DROP INDEX IF EXISTS memory_outbox_v2_one_attempt;
DROP INDEX IF EXISTS memory_outbox_state;
DROP INDEX IF EXISTS memory_outbox_reconcile;

CREATE TABLE memory_outbox (
  outbox_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 3 CHECK(schema_version=3),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  action_request_id TEXT UNIQUE REFERENCES control_command_requests(request_id),
  action_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  action_command_digest TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT UNIQUE,
  request_digest TEXT NOT NULL UNIQUE,
  request_json TEXT,
  candidate_digest TEXT,
  classification_digest TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct')),
  expected_page_id TEXT,
  expected_sid TEXT,
  expected_artifact_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','dispatching','reconciling','settled','conflict','failed','expired')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT,
  dispatch_fence INTEGER,
  dispatched_at TEXT,
  reconcile_deadline_at TEXT,
  failure_code TEXT,
  settlement_receipt_digest TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((operation='remember' AND (request_json IS NOT NULL OR action_request_id IS NULL)) OR (operation='correct' AND request_json IS NULL)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0))
);
CREATE INDEX memory_outbox_state ON memory_outbox(state,lease_expires_at,created_at,outbox_id);
CREATE INDEX memory_outbox_reconcile ON memory_outbox(state,reconcile_deadline_at,outbox_id) WHERE state='reconciling';

CREATE TABLE memory_outbox_attempts (
  attempt_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 3 CHECK(schema_version=3),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES memory_outbox(outbox_id),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number=1),
  dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
  invocation_digest TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('dispatching','accepted','uncertain')),
  outcome_code TEXT,
  accepted_result_json TEXT,
  acceptance_receipt_digest TEXT UNIQUE,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_outbox_attempts_outbox ON memory_outbox_attempts(outbox_id,created_at,attempt_id);
CREATE UNIQUE INDEX memory_outbox_v2_one_attempt ON memory_outbox_attempts(outbox_id);

CREATE TABLE memory_reconciliation_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 3 CHECK(schema_version=3),
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  attempt_id TEXT REFERENCES memory_outbox_attempts(attempt_id),
  reconcile_fence INTEGER NOT NULL CHECK(reconcile_fence>0),
  event_type TEXT NOT NULL CHECK(event_type IN ('dispatch_authority_spent','provider_accepted','dispatch_uncertain','artifact_missing','artifact_observed','artifact_conflict','reconcile_timeout','settled','failed','expired')),
  outcome_code TEXT,
  page_id TEXT,
  sid TEXT,
  source_version TEXT,
  observed_artifact_digest TEXT,
  effect_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_reconciliation_outbox ON memory_reconciliation_events(outbox_id,created_at,event_id);
CREATE UNIQUE INDEX memory_reconciliation_once ON memory_reconciliation_events(outbox_id,event_type) WHERE event_type IN ('dispatch_authority_spent','provider_accepted','artifact_observed','artifact_conflict','reconcile_timeout','settled','failed','expired');

INSERT INTO memory_outbox(
  outbox_id,candidate_id,action_request_id,action_receipt_id,action_command_digest,idempotency_key,
  request_id,request_digest,request_json,candidate_digest,classification_digest,operation,
  expected_page_id,expected_sid,expected_artifact_digest,state,lease_owner,lease_fence,
  lease_expires_at,dispatch_fence,dispatched_at,reconcile_deadline_at,failure_code,
  settlement_receipt_digest,expires_at,settled_at,created_at,updated_at
)
SELECT outbox_id,candidate_id,action_request_id,action_receipt_id,action_command_digest,idempotency_key,
  request_id,request_digest,CASE WHEN operation='remember' THEN request_json END,candidate_digest,
  classification_digest,operation,expected_page_id,expected_sid,expected_artifact_digest,
  CASE WHEN operation='correct' THEN 'conflict' ELSE state END,
  CASE WHEN operation='correct' THEN NULL ELSE lease_owner END,lease_fence,
  CASE WHEN operation='correct' THEN NULL ELSE lease_expires_at END,dispatch_fence,dispatched_at,
  reconcile_deadline_at,CASE WHEN operation='correct' THEN 'REAPPROVAL_REQUIRED' ELSE failure_code END,
  CASE WHEN operation='correct' THEN NULL ELSE settlement_receipt_digest END,expires_at,
  CASE WHEN operation='correct' THEN NULL ELSE settled_at END,created_at,updated_at
FROM memory_outbox_v2;

INSERT INTO memory_outbox_attempts(
  attempt_id,outbox_id,dispatch_fence,invocation_digest,request_digest,outcome,outcome_code,
  accepted_result_json,acceptance_receipt_digest,dispatched_at,completed_at,created_at,updated_at
)
SELECT a.attempt_id,a.outbox_id,a.dispatch_fence,a.invocation_digest,a.request_digest,a.outcome,
  CASE WHEN o.operation='correct' THEN 'REAPPROVAL_REQUIRED' ELSE a.outcome_code END,
  CASE WHEN o.operation='remember' THEN a.accepted_result_json END,
  CASE WHEN o.operation='remember' THEN a.acceptance_receipt_digest END,
  a.dispatched_at,a.completed_at,a.created_at,a.updated_at
FROM memory_outbox_attempts_v2 a JOIN memory_outbox o ON o.outbox_id=a.outbox_id;

INSERT INTO memory_reconciliation_events(
  event_id,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,page_id,sid,source_version,
  observed_artifact_digest,effect_digest,created_at
)
SELECT e.event_id,e.outbox_id,e.attempt_id,e.reconcile_fence,
  CASE WHEN o.operation='correct' AND e.event_type='settled' THEN 'failed' ELSE e.event_type END,
  CASE WHEN o.operation='correct' THEN 'REAPPROVAL_REQUIRED' ELSE e.outcome_code END,
  CASE WHEN o.operation='remember' THEN e.page_id END,CASE WHEN o.operation='remember' THEN e.sid END,
  CASE WHEN o.operation='remember' THEN e.source_version END,
  CASE WHEN o.operation='remember' THEN e.observed_artifact_digest END,e.effect_digest,e.created_at
FROM memory_reconciliation_events_v2 e JOIN memory_outbox o ON o.outbox_id=e.outbox_id;

DROP TABLE memory_reconciliation_events_v2;
DROP TABLE memory_outbox_attempts_v2;
DROP TABLE memory_outbox_v2;

CREATE TRIGGER memory_outbox_v3_candidate_guard BEFORE INSERT ON memory_outbox
WHEN NEW.operation<>'remember' OR NEW.request_json IS NULL OR NEW.state<>'queued' OR NOT EXISTS (
  SELECT 1 FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
  JOIN control_command_requests r ON r.request_id=NEW.action_request_id
  JOIN control_command_receipts a ON a.receipt_id=NEW.action_receipt_id AND a.request_id=r.request_id
  WHERE c.candidate_id=NEW.candidate_id AND c.state='approved' AND c.operation='remember'
    AND m.candidate_digest=NEW.candidate_digest AND m.classification_digest=NEW.classification_digest
    AND r.state='claimed' AND r.command_digest=NEW.action_command_digest AND a.decision='approve'
)
BEGIN SELECT RAISE(ABORT,'memory candidate approval required'); END;
CREATE TRIGGER memory_outbox_v3_queue_candidate AFTER INSERT ON memory_outbox BEGIN UPDATE memory_candidates SET state='queued',updated_at=NEW.created_at WHERE candidate_id=NEW.candidate_id; END;
CREATE TRIGGER memory_outbox_v3_identity BEFORE UPDATE OF outbox_id,schema_version,candidate_id,action_request_id,action_receipt_id,action_command_digest,idempotency_key,request_id,request_digest,request_json,candidate_digest,classification_digest,operation,expected_page_id,expected_sid,expected_artifact_digest,expires_at,created_at ON memory_outbox BEGIN SELECT RAISE(ABORT,'immutable memory outbox identity'); END;
CREATE TRIGGER memory_outbox_v3_transition BEFORE UPDATE OF state ON memory_outbox WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('queued:claimed','queued:failed','queued:expired','claimed:dispatching','claimed:failed','claimed:expired','dispatching:reconciling','reconciling:settled','reconciling:conflict') BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_v3_settlement_guard BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='settled' AND (NEW.settlement_receipt_digest IS NULL OR NOT EXISTS (
  SELECT 1 FROM memory_reconciliation_events o JOIN memory_reconciliation_events s
    ON s.outbox_id=o.outbox_id AND s.attempt_id=o.attempt_id AND s.reconcile_fence=o.reconcile_fence
  WHERE o.outbox_id=OLD.outbox_id AND o.reconcile_fence=OLD.lease_fence
    AND o.event_type='artifact_observed' AND o.observed_artifact_digest=OLD.expected_artifact_digest
    AND s.event_type='settled' AND s.effect_digest=NEW.settlement_receipt_digest
)) BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
CREATE TRIGGER memory_outbox_v3_settlement_immutable BEFORE UPDATE OF settlement_receipt_digest,settled_at ON memory_outbox WHEN OLD.state='settled' BEGIN SELECT RAISE(ABORT,'immutable memory outbox settlement'); END;
CREATE TRIGGER memory_outbox_v3_sync_candidate AFTER UPDATE OF state ON memory_outbox
BEGIN
  UPDATE memory_candidates SET state='accepted_unsettled',updated_at=NEW.updated_at
    WHERE candidate_id=NEW.candidate_id AND NEW.state IN ('dispatching','reconciling') AND state='queued';
  UPDATE memory_candidates SET state='settled',updated_at=NEW.updated_at
    WHERE candidate_id=NEW.candidate_id AND NEW.state='settled' AND state='accepted_unsettled';
  UPDATE memory_candidates SET state='uncertain',updated_at=NEW.updated_at
    WHERE candidate_id=NEW.candidate_id AND NEW.state IN ('conflict','failed')
      AND state IN ('queued','accepted_unsettled');
  UPDATE memory_candidates SET state='expired',updated_at=NEW.updated_at
    WHERE candidate_id=NEW.candidate_id AND NEW.state='expired' AND state='queued';
END;
CREATE TRIGGER memory_outbox_v3_attempt_immutable_update BEFORE UPDATE OF attempt_id,schema_version,outbox_id,attempt_number,dispatch_fence,invocation_digest,request_digest,dispatched_at,created_at ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_v3_attempt_immutable_delete BEFORE DELETE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_v3_event_immutable_update BEFORE UPDATE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_outbox_v3_event_immutable_delete BEFORE DELETE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;

CREATE TABLE memory_correction_requests (
  correction_id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  control_command_digest TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL UNIQUE,
  envelope_digest TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  delegation_id TEXT NOT NULL UNIQUE,
  delegation_digest TEXT NOT NULL UNIQUE,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL UNIQUE REFERENCES memory_tombstone_chain(sequence),
  tombstone_set_root TEXT NOT NULL,
  spool_locator TEXT,
  spool_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('approved','queued','dispatching','reconciling','provider_proved','settled','conflict')),
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
  CHECK((state IN ('approved','queued','dispatching') AND spool_locator IS NOT NULL) OR state IN ('reconciling','provider_proved','settled','conflict'))
);
CREATE INDEX memory_correction_state ON memory_correction_requests(state,updated_at,correction_id);
CREATE TABLE memory_correction_attempts (
  attempt_id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL UNIQUE REFERENCES memory_correction_requests(correction_id),
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
CREATE TABLE memory_correction_events (
  event_id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES memory_correction_requests(correction_id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('approved','suppressed','queued','dispatching','accepted','uncertain','provider_proved','purged','settled','conflict','timeout')),
  event_digest TEXT NOT NULL UNIQUE,
  proof_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(correction_id,sequence)
);
CREATE TABLE memory_correction_proofs (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_requests(correction_id),
  proof_id TEXT NOT NULL UNIQUE,
  proof_digest TEXT NOT NULL UNIQUE,
  provider_release_sha TEXT NOT NULL,
  result_generation_id TEXT NOT NULL,
  surface_manifest_digest TEXT NOT NULL,
  artifact_manifest_digest TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  purge_receipt_digest TEXT,
  settled_at TEXT
);
CREATE TRIGGER memory_correction_initial BEFORE INSERT ON memory_correction_requests WHEN NEW.state<>'approved' OR NEW.dispatch_fence<>0 BEGIN SELECT RAISE(ABORT,'memory correction must start approved'); END;
CREATE TRIGGER memory_correction_identity BEFORE UPDATE OF correction_id,lane_id,candidate_id,control_request_id,control_receipt_id,control_command_digest,provider_instance_id,request_id,request_digest,envelope_digest,idempotency_key,delegation_id,delegation_digest,target_manifest_digest,scope_digest,payload_digest,tombstone_sequence,tombstone_set_root,spool_digest,expires_at,created_at ON memory_correction_requests BEGIN SELECT RAISE(ABORT,'immutable memory correction identity'); END;
CREATE TRIGGER memory_correction_transition BEFORE UPDATE OF state ON memory_correction_requests WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('approved:queued','queued:dispatching','dispatching:reconciling','dispatching:conflict','reconciling:provider_proved','reconciling:conflict','provider_proved:settled','provider_proved:conflict') BEGIN SELECT RAISE(ABORT,'memory correction transition invalid'); END;
CREATE TRIGGER memory_correction_one_send BEFORE UPDATE OF dispatch_fence ON memory_correction_requests WHEN NEW.dispatch_fence<>OLD.dispatch_fence AND NOT (OLD.dispatch_fence=0 AND NEW.dispatch_fence=1 AND OLD.state='queued' AND NEW.state='dispatching') BEGIN SELECT RAISE(ABORT,'memory correction dispatch already spent'); END;
CREATE TRIGGER memory_correction_settlement BEFORE UPDATE OF state ON memory_correction_requests WHEN NEW.state='settled' AND (NEW.provider_proof_digest IS NULL OR NEW.surface_manifest_digest IS NULL OR NEW.purge_receipt_digest IS NULL OR NOT EXISTS (SELECT 1 FROM memory_correction_proofs p WHERE p.correction_id=OLD.correction_id AND p.proof_digest=NEW.provider_proof_digest AND p.surface_manifest_digest=NEW.surface_manifest_digest AND p.purge_receipt_digest=NEW.purge_receipt_digest)) BEGIN SELECT RAISE(ABORT,'memory correction proof required'); END;
CREATE TRIGGER memory_correction_attempt_immutable_update BEFORE UPDATE OF attempt_id,correction_id,dispatch_fence,invocation_digest,dispatched_at,created_at ON memory_correction_attempts BEGIN SELECT RAISE(ABORT,'immutable memory correction attempt'); END;
CREATE TRIGGER memory_correction_attempt_immutable_delete BEFORE DELETE ON memory_correction_attempts BEGIN SELECT RAISE(ABORT,'immutable memory correction attempt'); END;
CREATE TRIGGER memory_correction_event_immutable_update BEFORE UPDATE ON memory_correction_events BEGIN SELECT RAISE(ABORT,'immutable memory correction event'); END;
CREATE TRIGGER memory_correction_event_immutable_delete BEFORE DELETE ON memory_correction_events BEGIN SELECT RAISE(ABORT,'immutable memory correction event'); END;
CREATE TRIGGER memory_candidate_confirmation_v3_guard BEFORE UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved' AND NOT EXISTS (
  SELECT 1 FROM control_command_requests r
  JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
  JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
  WHERE r.request_id=NEW.confirmation_request_id AND a.receipt_id=NEW.confirmation_receipt_id
    AND r.action='memory.confirm' AND r.action_level=3 AND r.state='claimed' AND a.decision='approve'
    AND r.command_digest=a.command_digest AND NEW.confirmation_principal_id='principal:owner'
    AND r.requested_by='principal:owner' AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
    AND json_extract(r.target_json,'$.candidate_digest')=(SELECT candidate_digest FROM memory_candidate_classifications WHERE candidate_id=NEW.candidate_id)
    AND json_extract(r.target_json,'$.classification_digest')=(SELECT classification_digest FROM memory_candidate_classifications WHERE candidate_id=NEW.candidate_id)
    AND json_extract(r.args_json,'$.operation')='correct'
    AND json_extract(r.args_json,'$.evidence_digest')=NEW.confirmation_evidence_digest
    AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
    AND julianday(NEW.updated_at)<julianday(r.expires_at) AND julianday(NEW.updated_at)<julianday(a.expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory correction confirmation required'); END;
CREATE TRIGGER memory_candidate_confirmation_v3_redeem AFTER UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
BEGIN
  INSERT INTO personal_authority_redemptions(
    receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at
  ) VALUES(NEW.confirmation_receipt_id,NEW.confirmation_request_id,'memory_confirmation',
    NEW.candidate_id,NEW.confirmation_receipt_digest,NEW.updated_at);
END;
