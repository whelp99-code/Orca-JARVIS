-- Task 32 v6: remove provider write content from the AuthorityDb.
-- The content remains in the private review/dispatch spool and is never copied
-- into this durable database. This is forward-only; prior migration bytes stay
-- unchanged for checksum and historical reproducibility.
DROP TRIGGER IF EXISTS memory_outbox_v2_candidate_guard;
DROP TRIGGER IF EXISTS memory_outbox_v2_identity_immutable;
DROP TRIGGER IF EXISTS memory_outbox_v3_candidate_guard;
DROP TRIGGER IF EXISTS memory_outbox_v3_identity;
DROP TRIGGER IF EXISTS memory_candidate_confirmation_guard;
DROP TRIGGER IF EXISTS memory_candidate_confirmation_redeem;
DROP TRIGGER IF EXISTS memory_candidate_confirmation_v3_guard;
DROP TRIGGER IF EXISTS memory_candidate_confirmation_v3_redeem;

DROP INDEX IF EXISTS memory_outbox_state;
DROP INDEX IF EXISTS memory_outbox_reconcile;
DROP INDEX IF EXISTS memory_outbox_attempts_outbox;
DROP INDEX IF EXISTS memory_outbox_v2_one_attempt;
DROP INDEX IF EXISTS memory_reconciliation_outbox;
DROP INDEX IF EXISTS memory_reconciliation_once;

ALTER TABLE "memory_reconciliation_events" RENAME TO memory_reconciliation_events_v6_contentful;
ALTER TABLE "memory_outbox_attempts" RENAME TO memory_outbox_attempts_v6_contentful;
ALTER TABLE "memory_outbox" RENAME TO memory_outbox_v6_contentful;

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
CREATE UNIQUE INDEX memory_reconciliation_once ON memory_reconciliation_events(outbox_id,event_type)
  WHERE event_type IN ('dispatch_authority_spent','provider_accepted','artifact_observed','artifact_conflict','reconcile_timeout','settled','failed','expired');

INSERT INTO memory_outbox(
  outbox_id,schema_version,candidate_id,action_request_id,action_receipt_id,action_command_digest,
  idempotency_key,request_id,request_digest,candidate_digest,classification_digest,operation,
  expected_page_id,expected_sid,expected_artifact_digest,state,lease_owner,lease_fence,
  lease_expires_at,dispatch_fence,dispatched_at,reconcile_deadline_at,failure_code,
  settlement_receipt_digest,expires_at,settled_at,created_at,updated_at
)
SELECT outbox_id,schema_version,candidate_id,action_request_id,action_receipt_id,action_command_digest,
  idempotency_key,request_id,request_digest,candidate_digest,classification_digest,operation,
  expected_page_id,expected_sid,expected_artifact_digest,state,lease_owner,lease_fence,
  lease_expires_at,dispatch_fence,dispatched_at,reconcile_deadline_at,failure_code,
  settlement_receipt_digest,expires_at,settled_at,created_at,updated_at
FROM memory_outbox_v6_contentful;

INSERT INTO memory_outbox_attempts(
  attempt_id,schema_version,outbox_id,attempt_number,dispatch_fence,invocation_digest,request_digest,
  outcome,outcome_code,accepted_result_json,acceptance_receipt_digest,dispatched_at,completed_at,
  created_at,updated_at
)
SELECT attempt_id,schema_version,outbox_id,attempt_number,dispatch_fence,invocation_digest,request_digest,
  outcome,outcome_code,accepted_result_json,acceptance_receipt_digest,dispatched_at,completed_at,
  created_at,updated_at
FROM memory_outbox_attempts_v6_contentful;

INSERT INTO memory_reconciliation_events(
  event_id,schema_version,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,page_id,sid,
  source_version,observed_artifact_digest,effect_digest,created_at
)
SELECT event_id,schema_version,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,page_id,sid,
  source_version,observed_artifact_digest,effect_digest,created_at
FROM memory_reconciliation_events_v6_contentful;

DROP TABLE memory_reconciliation_events_v6_contentful;
DROP TABLE memory_outbox_attempts_v6_contentful;
DROP TABLE memory_outbox_v6_contentful;

CREATE TRIGGER memory_outbox_v3_candidate_guard BEFORE INSERT ON memory_outbox
WHEN NEW.operation<>'remember' OR NEW.state<>'queued' OR NEW.action_request_id IS NULL
  OR NEW.action_receipt_id IS NULL OR NEW.action_command_digest IS NULL
  OR NEW.request_id IS NULL OR NEW.candidate_digest IS NULL OR NEW.classification_digest IS NULL
  OR NEW.expected_page_id IS NULL OR NEW.expected_sid IS NULL OR NOT EXISTS (
  SELECT 1 FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
  JOIN control_command_requests r ON r.request_id=NEW.action_request_id
  JOIN control_command_receipts a ON a.receipt_id=NEW.action_receipt_id AND a.request_id=r.request_id
  WHERE c.candidate_id=NEW.candidate_id AND c.state='approved' AND c.operation='remember'
    AND m.candidate_digest=NEW.candidate_digest AND m.classification_digest=NEW.classification_digest
    AND r.state='claimed' AND r.command_digest=NEW.action_command_digest AND a.decision='approve'
)
BEGIN SELECT RAISE(ABORT,'memory candidate approval required'); END;
CREATE TRIGGER memory_outbox_v3_queue_candidate AFTER INSERT ON memory_outbox
BEGIN UPDATE memory_candidates SET state='queued',updated_at=NEW.created_at WHERE candidate_id=NEW.candidate_id; END;
CREATE TRIGGER memory_outbox_v3_identity BEFORE UPDATE OF
  outbox_id,schema_version,candidate_id,action_request_id,action_receipt_id,action_command_digest,
  idempotency_key,request_id,request_digest,candidate_digest,classification_digest,operation,
  expected_page_id,expected_sid,expected_artifact_digest,expires_at,created_at ON memory_outbox
BEGIN SELECT RAISE(ABORT,'immutable memory outbox identity'); END;
CREATE TRIGGER memory_outbox_v3_transition BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('queued:claimed','queued:failed','queued:expired','claimed:dispatching','claimed:failed','claimed:expired','dispatching:reconciling','reconciling:settled','reconciling:conflict')
BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_v3_settlement_guard BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='settled' AND (NEW.settlement_receipt_digest IS NULL OR NOT EXISTS (
  SELECT 1 FROM memory_reconciliation_events o JOIN memory_reconciliation_events s
    ON s.outbox_id=o.outbox_id AND s.attempt_id=o.attempt_id AND s.reconcile_fence=o.reconcile_fence
  WHERE o.outbox_id=OLD.outbox_id AND o.reconcile_fence=OLD.lease_fence
    AND o.event_type='artifact_observed' AND o.observed_artifact_digest=OLD.expected_artifact_digest
    AND s.event_type='settled' AND s.effect_digest=NEW.settlement_receipt_digest
)) BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
CREATE TRIGGER memory_outbox_v3_settlement_immutable BEFORE UPDATE OF settlement_receipt_digest,settled_at ON memory_outbox WHEN OLD.state='settled'
BEGIN SELECT RAISE(ABORT,'immutable memory outbox settlement'); END;
CREATE TRIGGER memory_outbox_v3_sync_candidate AFTER UPDATE OF state ON memory_outbox
BEGIN
  UPDATE memory_candidates SET state='accepted_unsettled',updated_at=NEW.updated_at WHERE candidate_id=NEW.candidate_id AND NEW.state IN ('dispatching','reconciling') AND state='queued';
  UPDATE memory_candidates SET state='settled',updated_at=NEW.updated_at WHERE candidate_id=NEW.candidate_id AND NEW.state='settled' AND state='accepted_unsettled';
  UPDATE memory_candidates SET state='uncertain',updated_at=NEW.updated_at WHERE candidate_id=NEW.candidate_id AND NEW.state IN ('conflict','failed') AND state IN ('queued','accepted_unsettled');
  UPDATE memory_candidates SET state='expired',updated_at=NEW.updated_at WHERE candidate_id=NEW.candidate_id AND NEW.state='expired' AND state='queued';
END;
CREATE TRIGGER memory_outbox_v3_attempt_immutable_update BEFORE UPDATE OF attempt_id,schema_version,outbox_id,attempt_number,dispatch_fence,invocation_digest,request_digest,dispatched_at,created_at ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_v3_attempt_immutable_delete BEFORE DELETE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_v3_event_immutable_update BEFORE UPDATE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_outbox_v3_event_immutable_delete BEFORE DELETE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;

ALTER TABLE "memory_candidate_decision_attempts" ADD COLUMN target_version_digest TEXT;
ALTER TABLE "memory_candidate_decision_attempts" ADD COLUMN expected_prior_digest TEXT;
ALTER TABLE "memory_candidate_decision_attempts" ADD COLUMN target_manifest_digest TEXT;
ALTER TABLE "memory_candidate_decision_attempts" ADD COLUMN scope_digest TEXT;
ALTER TABLE "memory_candidate_decision_attempts" ADD COLUMN expected_prior_json TEXT;

CREATE TRIGGER memory_candidate_v6_owner_decision_guard
BEFORE INSERT ON memory_candidate_owner_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM memory_candidate_decision_attempts a
  JOIN memory_candidate_decision_families f ON f.family_digest=a.family_digest
  JOIN control_command_requests r ON r.request_id=NEW.control_request_id
  JOIN control_command_receipts c ON c.receipt_id=NEW.control_receipt_id AND c.request_id=r.request_id
  WHERE a.attempt_id=NEW.attempt_id AND f.candidate_id=NEW.candidate_id AND f.decision=NEW.decision
    AND r.action='memory.confirm' AND r.state='approved' AND c.decision='approve'
    AND c.command_digest=r.command_digest AND NEW.command_digest=r.command_digest
)
BEGIN SELECT RAISE(ABORT,'memory candidate owner decision authority required'); END;

-- Task 32 v6: restore confirmation authority dropped above, accepting the legacy
-- control-command shape or the v6 owner-decision attempt shape.
CREATE TRIGGER memory_candidate_confirmation_guard
BEFORE UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
  AND NEW.operation='remember' AND NOT EXISTS (
    SELECT 1 FROM control_command_requests r
    JOIN control_command_receipts a ON a.request_id=r.request_id
    WHERE r.request_id=NEW.confirmation_request_id
      AND a.receipt_id=NEW.confirmation_receipt_id
      AND r.action='memory.confirm' AND r.action_level=3
      AND r.state='approved' AND a.decision='approve'
      AND a.command_digest=r.command_digest
      AND NEW.confirmation_principal_id='local-owner'
      AND r.requested_by='local-owner'
      AND a.signer_principal_id='local-owner'
      AND a.authenticated_session_id='session:local-owner'
      AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
      AND json_extract(r.target_json,'$.subject_digest')=NEW.subject_digest
      AND json_extract(r.target_json,'$.content_digest')=NEW.content_digest
      AND json_extract(r.args_json,'$.operation')=NEW.operation
      AND json_extract(r.args_json,'$.evidence_digest')=NEW.confirmation_evidence_digest
      AND json_extract(a.payload_json,'$.receipt_digest')=NEW.confirmation_receipt_digest
      AND NOT EXISTS (
        SELECT 1 FROM personal_authority_redemptions
        WHERE receipt_id=a.receipt_id OR request_id=r.request_id
      )
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(NEW.expires_at)
      AND julianday(NEW.updated_at)<julianday(r.expires_at)
      AND julianday(NEW.updated_at)<julianday(a.expires_at)
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_candidate_owner_decisions d
    JOIN memory_candidate_decision_attempts t ON t.attempt_id=d.attempt_id
    JOIN memory_candidate_decision_families f ON f.family_digest=t.family_digest
    WHERE d.candidate_id=NEW.candidate_id AND d.decision='confirm'
      AND d.control_request_id=NEW.confirmation_request_id
      AND d.control_receipt_id=NEW.confirmation_receipt_id
      AND d.command_digest=(
        SELECT command_digest FROM control_command_requests
        WHERE request_id=NEW.confirmation_request_id
      )
      AND f.content_digest=NEW.content_digest
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(NEW.expires_at)
  )
BEGIN SELECT RAISE(ABORT,'memory confirmation authority required'); END;

CREATE TRIGGER memory_candidate_confirmation_v3_guard
BEFORE UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
  AND NEW.operation='correct' AND NOT EXISTS (
    SELECT 1 FROM control_command_requests r
    JOIN control_command_redemptions x
      ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
    JOIN control_command_receipts a
      ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
    WHERE r.request_id=NEW.confirmation_request_id
      AND a.receipt_id=NEW.confirmation_receipt_id
      AND r.action='memory.confirm' AND r.action_level=3
      AND r.state='claimed' AND a.decision='approve'
      AND r.command_digest=a.command_digest
      AND NEW.confirmation_principal_id='principal:owner'
      AND r.requested_by='principal:owner'
      AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
      AND json_extract(r.target_json,'$.candidate_digest')=(
        SELECT candidate_digest FROM memory_candidate_classifications
        WHERE candidate_id=NEW.candidate_id
      )
      AND json_extract(r.target_json,'$.classification_digest')=(
        SELECT classification_digest FROM memory_candidate_classifications
        WHERE candidate_id=NEW.candidate_id
      )
      AND json_extract(r.args_json,'$.operation')='correct'
      AND json_extract(r.args_json,'$.evidence_digest')=NEW.confirmation_evidence_digest
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(r.expires_at)
      AND julianday(NEW.updated_at)<julianday(a.expires_at)
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_candidate_owner_decisions d
    JOIN memory_candidate_decision_attempts t ON t.attempt_id=d.attempt_id
    JOIN memory_candidate_decision_families f ON f.family_digest=t.family_digest
    WHERE d.candidate_id=NEW.candidate_id AND d.decision='confirm'
      AND d.control_request_id=NEW.confirmation_request_id
      AND d.control_receipt_id=NEW.confirmation_receipt_id
      AND d.command_digest=(
        SELECT command_digest FROM control_command_requests
        WHERE request_id=NEW.confirmation_request_id
      )
      AND f.content_digest=NEW.content_digest
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(NEW.expires_at)
  )
BEGIN SELECT RAISE(ABORT,'memory correction confirmation required'); END;

CREATE TRIGGER memory_candidate_confirmation_redeem
AFTER UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
BEGIN
  INSERT INTO personal_authority_redemptions(
    receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at
  ) VALUES(
    NEW.confirmation_receipt_id,NEW.confirmation_request_id,'memory_confirmation',
    NEW.candidate_id,NEW.confirmation_receipt_digest,NEW.updated_at
  );
END;

-- Task 32 v6: the recreated memory_outbox lost the shipped v2-named state and
-- settlement guards; restore them alongside their v3 equivalents.
CREATE TRIGGER memory_outbox_v2_transition
BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'queued:claimed','queued:failed','queued:expired','claimed:dispatching',
  'claimed:failed','claimed:expired','dispatching:reconciling',
  'reconciling:settled','reconciling:conflict'
)
BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;

CREATE TRIGGER memory_outbox_v2_settlement_guard
BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='settled' AND (
  NEW.settlement_receipt_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM memory_reconciliation_events o
    JOIN memory_reconciliation_events s
      ON s.outbox_id=o.outbox_id AND s.attempt_id=o.attempt_id
      AND s.reconcile_fence=o.reconcile_fence
    WHERE o.outbox_id=OLD.outbox_id
      AND o.reconcile_fence=OLD.lease_fence
      AND o.event_type='artifact_observed'
      AND o.observed_artifact_digest=OLD.expected_artifact_digest
      AND s.event_type='settled'
      AND s.effect_digest=NEW.settlement_receipt_digest
  )
)
BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
