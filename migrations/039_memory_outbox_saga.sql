-- Task 29 closed forward-only V2 memory outbox saga rebuild.
DROP TRIGGER memory_candidates_transition; DROP TRIGGER memory_outbox_candidate_guard;
DROP TRIGGER memory_outbox_queue_candidate;
DROP TRIGGER memory_outbox_identity_immutable; DROP TRIGGER memory_outbox_transition;
DROP TRIGGER memory_outbox_current_lease_guard; DROP TRIGGER memory_outbox_claim_guard;
DROP TRIGGER memory_outbox_reclaim_guard; DROP TRIGGER memory_outbox_active_lease;
DROP TRIGGER memory_outbox_lease_expiry_guard; DROP TRIGGER memory_outbox_settlement_guard;
DROP TRIGGER memory_outbox_attempt_guard; DROP TRIGGER memory_reconciliation_fence_guard;
DROP TRIGGER memory_outbox_sync_candidate; DROP TRIGGER memory_outbox_attempts_immutable_update;
DROP TRIGGER memory_outbox_attempts_immutable_delete;
DROP TRIGGER memory_reconciliation_immutable_update; DROP TRIGGER memory_reconciliation_immutable_delete;

CREATE TABLE memory_outbox_migration_guard(code TEXT PRIMARY KEY);
CREATE TRIGGER memory_outbox_migration_abort BEFORE INSERT ON memory_outbox_migration_guard BEGIN SELECT RAISE(ABORT,'MEMORY_OUTBOX_MIGRATION_INVALID'); END;
INSERT INTO memory_outbox_migration_guard
SELECT outbox_id FROM memory_outbox WHERE state NOT IN (
  'queued','delivering','accepted_unsettled','settled','rejected','uncertain','expired'
) OR operation NOT IN ('remember','correct');
INSERT INTO memory_outbox_migration_guard
SELECT o.outbox_id FROM memory_outbox o WHERE o.state='settled' AND NOT EXISTS (
  SELECT 1 FROM memory_reconciliation_events e WHERE e.outbox_id=o.outbox_id
    AND e.event_type='artifact_observed' AND e.observed_artifact_digest=o.expected_artifact_digest
);
INSERT INTO memory_outbox_migration_guard
SELECT outbox_id FROM memory_outbox_attempts GROUP BY outbox_id HAVING COUNT(*)>1;
DROP TRIGGER memory_outbox_migration_abort; DROP TABLE memory_outbox_migration_guard;

ALTER TABLE memory_outbox RENAME TO memory_outbox_v1;
ALTER TABLE memory_outbox_attempts RENAME TO memory_outbox_attempts_v1;
ALTER TABLE memory_reconciliation_events RENAME TO memory_reconciliation_events_v1;
DROP INDEX memory_outbox_state; DROP INDEX memory_outbox_attempts_outbox; DROP INDEX memory_reconciliation_outbox;

CREATE TABLE memory_outbox (
  outbox_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version=2),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  action_request_id TEXT UNIQUE REFERENCES control_command_requests(request_id), action_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
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
  state TEXT NOT NULL CHECK(state IN (
    'queued','claimed','dispatching','reconciling','settled','conflict','failed','expired'
  )),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  dispatch_fence INTEGER CHECK(dispatch_fence IS NULL OR dispatch_fence>0),
  dispatched_at TEXT CHECK(dispatched_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',dispatched_at)=dispatched_at),
  reconcile_deadline_at TEXT CHECK(reconcile_deadline_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',reconcile_deadline_at)=reconcile_deadline_at),
  failure_code TEXT, settlement_receipt_digest TEXT UNIQUE,
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  settled_at TEXT CHECK(settled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK((dispatch_fence IS NULL AND dispatched_at IS NULL AND reconcile_deadline_at IS NULL) OR
    (dispatch_fence IS NOT NULL AND dispatched_at IS NOT NULL AND reconcile_deadline_at IS NOT NULL)),
  CHECK(state NOT IN ('claimed','dispatching') OR lease_owner IS NOT NULL)
);
CREATE INDEX memory_outbox_state ON memory_outbox(state,lease_expires_at,created_at,outbox_id);
CREATE INDEX memory_outbox_reconcile ON memory_outbox(state,reconcile_deadline_at,outbox_id) WHERE state='reconciling';

CREATE TABLE memory_outbox_attempts (
  attempt_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version=2),
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number=1),
  dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
  invocation_digest TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('dispatching','accepted','uncertain')),
  outcome_code TEXT, accepted_result_json TEXT,
  acceptance_receipt_digest TEXT UNIQUE,
  dispatched_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',dispatched_at)=dispatched_at),
  completed_at TEXT CHECK(completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',completed_at)=completed_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at)
);
CREATE INDEX memory_outbox_attempts_outbox ON memory_outbox_attempts(outbox_id,created_at,attempt_id);
CREATE UNIQUE INDEX memory_outbox_v2_one_attempt ON memory_outbox_attempts(outbox_id);

CREATE TABLE memory_reconciliation_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version=2),
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  attempt_id TEXT REFERENCES memory_outbox_attempts(attempt_id),
  reconcile_fence INTEGER NOT NULL CHECK(reconcile_fence>0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'dispatch_authority_spent','provider_accepted','dispatch_uncertain','artifact_missing',
    'artifact_observed','artifact_conflict','reconcile_timeout','settled','failed','expired'
  )),
  outcome_code TEXT, page_id TEXT,
  sid TEXT, source_version TEXT, observed_artifact_digest TEXT,
  effect_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX memory_reconciliation_outbox ON memory_reconciliation_events(outbox_id,created_at,event_id);
CREATE UNIQUE INDEX memory_reconciliation_once ON memory_reconciliation_events(outbox_id,event_type)
  WHERE event_type IN (
    'dispatch_authority_spent','provider_accepted','artifact_observed','artifact_conflict',
    'reconcile_timeout','settled','failed','expired'
  );

INSERT INTO memory_outbox(
  outbox_id,candidate_id,idempotency_key,request_digest,operation,expected_artifact_digest,state,
  lease_fence,dispatch_fence,dispatched_at,reconcile_deadline_at,failure_code,expires_at,
  settlement_receipt_digest,settled_at,created_at,updated_at
)
SELECT outbox_id,candidate_id,idempotency_key,request_digest,operation,expected_artifact_digest,
  CASE state WHEN 'delivering' THEN 'reconciling' WHEN 'accepted_unsettled' THEN 'reconciling'
    WHEN 'uncertain' THEN 'reconciling' WHEN 'rejected' THEN 'failed' ELSE state END,
  lease_fence,
  CASE WHEN state IN ('delivering','accepted_unsettled','uncertain','settled') THEN MAX(lease_fence,1) END,
  CASE WHEN state IN ('delivering','accepted_unsettled','uncertain','settled') THEN updated_at END,
  CASE WHEN state IN ('delivering','accepted_unsettled','uncertain','settled')
    THEN strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at)+10.0/1440.0) END,
  CASE WHEN state='rejected' THEN 'LEGACY_REJECTED' END,expires_at,
  CASE WHEN state='settled' THEN (
    SELECT effect_digest FROM memory_reconciliation_events_v1 e WHERE e.outbox_id=memory_outbox_v1.outbox_id
      AND e.event_type='artifact_observed' AND e.observed_artifact_digest=memory_outbox_v1.expected_artifact_digest
    ORDER BY e.created_at,e.event_id LIMIT 1
  ) END,settled_at,created_at,updated_at
FROM memory_outbox_v1;

INSERT INTO memory_outbox_attempts(
  attempt_id,outbox_id,dispatch_fence,invocation_digest,request_digest,outcome,outcome_code,
  dispatched_at,completed_at,created_at,updated_at
)
SELECT a.attempt_id,a.outbox_id,a.lease_fence,a.invocation_digest,o.request_digest,
  CASE a.outcome WHEN 'accepted' THEN 'accepted' ELSE 'uncertain' END,
  CASE WHEN a.outcome='rejected' THEN COALESCE(a.error_code,'LEGACY_REJECTED') ELSE a.error_code END,
  a.created_at,a.created_at,a.created_at,a.created_at
FROM memory_outbox_attempts_v1 a JOIN memory_outbox o ON o.outbox_id=a.outbox_id;

INSERT INTO memory_reconciliation_events(
  event_id,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,
  observed_artifact_digest,effect_digest,created_at
)
SELECT event_id,outbox_id,attempt_id,lease_fence,
  CASE event_type WHEN 'accepted' THEN 'provider_accepted' WHEN 'conflict' THEN 'artifact_conflict'
    WHEN 'uncertain' THEN 'dispatch_uncertain' ELSE event_type END,
  NULL,observed_artifact_digest,effect_digest,created_at
FROM memory_reconciliation_events_v1;

DROP TABLE memory_reconciliation_events_v1; DROP TABLE memory_outbox_attempts_v1; DROP TABLE memory_outbox_v1;

CREATE TRIGGER memory_candidates_transition BEFORE UPDATE OF state ON memory_candidates WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'proposed:classified','proposed:rejected','proposed:expired','classified:awaiting_confirmation','classified:approved',
  'classified:rejected','classified:expired','awaiting_confirmation:approved','awaiting_confirmation:rejected',
  'awaiting_confirmation:expired','approved:queued','approved:rejected','approved:expired','queued:delivering',
  'queued:accepted_unsettled','queued:uncertain','queued:expired','delivering:accepted_unsettled','delivering:uncertain',
  'delivering:expired','accepted_unsettled:settled','accepted_unsettled:uncertain','accepted_unsettled:expired'
) BEGIN SELECT RAISE(ABORT,'memory candidate transition invalid'); END;
CREATE TRIGGER memory_outbox_v2_candidate_guard BEFORE INSERT ON memory_outbox
WHEN NEW.action_request_id IS NULL OR NEW.action_receipt_id IS NULL OR NEW.action_command_digest IS NULL
  OR NEW.request_id IS NULL OR NEW.request_json IS NULL OR NEW.candidate_digest IS NULL
  OR NEW.classification_digest IS NULL OR NEW.expected_page_id IS NULL OR NEW.expected_sid IS NULL
  OR NEW.state<>'queued' OR NOT EXISTS (
    SELECT 1 FROM memory_candidates c
    JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
    JOIN control_command_requests r ON r.request_id=NEW.action_request_id
    JOIN control_command_receipts a ON a.receipt_id=NEW.action_receipt_id AND a.request_id=r.request_id
    WHERE c.candidate_id=NEW.candidate_id AND c.state='approved' AND c.operation=NEW.operation
      AND m.candidate_digest=NEW.candidate_digest AND m.classification_digest=NEW.classification_digest
      AND r.state='claimed' AND r.command_digest=NEW.action_command_digest
      AND a.decision='approve' AND a.command_digest=NEW.action_command_digest
      AND julianday(c.expires_at)>julianday(NEW.created_at)
  )
BEGIN SELECT RAISE(ABORT,'memory candidate approval required'); END;
CREATE TRIGGER memory_outbox_v2_queue_candidate AFTER INSERT ON memory_outbox
  BEGIN UPDATE memory_candidates SET state='queued',updated_at=NEW.created_at
  WHERE candidate_id=NEW.candidate_id; END;
CREATE TRIGGER memory_outbox_v2_identity_immutable BEFORE UPDATE OF
  outbox_id,schema_version,candidate_id,action_request_id,action_receipt_id,action_command_digest,
  idempotency_key,request_id,request_digest,request_json,candidate_digest,classification_digest,
  operation,expected_page_id,expected_sid,expected_artifact_digest,expires_at,created_at ON memory_outbox
BEGIN SELECT RAISE(ABORT,'immutable memory outbox identity'); END;
CREATE TRIGGER memory_outbox_v2_transition BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'queued:claimed','queued:failed','queued:expired','claimed:dispatching','claimed:failed',
  'claimed:expired','dispatching:reconciling','reconciling:settled','reconciling:conflict'
) BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_v2_claim_guard BEFORE UPDATE OF lease_fence ON memory_outbox
WHEN NEW.lease_fence<>OLD.lease_fence AND NOT (
  (OLD.state='queued' AND NEW.state='claimed' AND OLD.lease_fence=0 AND NEW.lease_fence=1)
  OR (OLD.state='claimed' AND NEW.state='claimed' AND NEW.lease_fence=OLD.lease_fence+1
    AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at))
  OR (OLD.state='reconciling' AND NEW.state='reconciling' AND NEW.lease_fence=OLD.lease_fence+1
    AND (OLD.lease_owner IS NULL OR julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at)))
) BEGIN SELECT RAISE(ABORT,'memory outbox claim invalid'); END;
CREATE TRIGGER memory_outbox_v2_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON memory_outbox
WHEN OLD.lease_owner IS NOT NULL AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at)
  AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner)
    OR NEW.lease_fence<>OLD.lease_fence)
BEGIN SELECT RAISE(ABORT,'memory outbox active lease exists'); END;
CREATE TRIGGER memory_outbox_v2_dispatch_guard BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='dispatching' AND NOT (
  OLD.state='claimed' AND OLD.lease_owner IS NOT NULL AND NEW.lease_fence=OLD.lease_fence
  AND NEW.dispatch_fence=OLD.lease_fence AND julianday(NEW.updated_at)<julianday(OLD.lease_expires_at)
  AND julianday(NEW.updated_at)<julianday(OLD.expires_at)
) BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_outbox_v2_settlement_guard BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='settled' AND (NEW.settlement_receipt_digest IS NULL OR NOT EXISTS (
  SELECT 1 FROM memory_reconciliation_events o JOIN memory_reconciliation_events s
    ON s.outbox_id=o.outbox_id AND s.attempt_id=o.attempt_id AND s.reconcile_fence=o.reconcile_fence
  WHERE o.outbox_id=OLD.outbox_id AND o.reconcile_fence=OLD.lease_fence
    AND o.event_type='artifact_observed' AND o.observed_artifact_digest=OLD.expected_artifact_digest
    AND s.event_type='settled' AND s.effect_digest=NEW.settlement_receipt_digest
)) BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
CREATE TRIGGER memory_outbox_v2_settlement_immutable
BEFORE UPDATE OF settlement_receipt_digest,settled_at ON memory_outbox WHEN OLD.state='settled'
BEGIN SELECT RAISE(ABORT,'immutable memory outbox settlement'); END;
CREATE TRIGGER memory_outbox_v2_attempt_insert BEFORE INSERT ON memory_outbox_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM memory_outbox o WHERE o.outbox_id=NEW.outbox_id AND o.state='dispatching'
    AND o.dispatch_fence=NEW.dispatch_fence AND o.lease_fence=NEW.dispatch_fence
    AND o.lease_owner IS NOT NULL AND julianday(o.lease_expires_at)>julianday(NEW.created_at)
) BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_outbox_v2_attempt_identity BEFORE UPDATE OF
  attempt_id,schema_version,outbox_id,attempt_number,dispatch_fence,invocation_digest,
  request_digest,dispatched_at,created_at ON memory_outbox_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_v2_attempt_transition BEFORE UPDATE OF outcome ON memory_outbox_attempts
WHEN OLD.outcome<>NEW.outcome AND (OLD.outcome<>'dispatching' OR NEW.outcome NOT IN ('accepted','uncertain'))
BEGIN SELECT RAISE(ABORT,'memory outbox attempt transition invalid'); END;
CREATE TRIGGER memory_outbox_v2_attempt_delete BEFORE DELETE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_reconciliation_v2_fence BEFORE INSERT ON memory_reconciliation_events
WHEN NEW.event_type IN ('artifact_missing','artifact_observed','artifact_conflict','reconcile_timeout')
  AND NOT EXISTS (
    SELECT 1 FROM memory_outbox o WHERE o.outbox_id=NEW.outbox_id AND o.state='reconciling'
      AND o.lease_owner IS NOT NULL AND o.lease_fence=NEW.reconcile_fence
      AND julianday(o.lease_expires_at)>julianday(NEW.created_at)
  )
BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_reconciliation_v2_immutable_update BEFORE UPDATE ON memory_reconciliation_events
  BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_reconciliation_v2_immutable_delete BEFORE DELETE ON memory_reconciliation_events
  BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_outbox_v2_sync_candidate AFTER UPDATE OF state ON memory_outbox
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
