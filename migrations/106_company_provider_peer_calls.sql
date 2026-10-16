CREATE TABLE company_peer_calls (
  operation_id TEXT PRIMARY KEY,
  provider_instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  operation TEXT NOT NULL CHECK(operation IN ('decide_approve','decide_reject','accept','reject','complete','mark_processed')),
  transition_request_digest TEXT NOT NULL,
  original_arguments_json TEXT NOT NULL CHECK(json_valid(original_arguments_json)),
  state TEXT NOT NULL CHECK(state IN ('prepared','invoking','uncertain','found')),
  receipt_projection_json TEXT CHECK(receipt_projection_json IS NULL OR json_valid(receipt_projection_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((state='found' AND receipt_projection_json IS NOT NULL)
    OR (state<>'found' AND receipt_projection_json IS NULL))
);
CREATE INDEX company_peer_calls_pending_scope
ON company_peer_calls(provider_instance_id,workspace_id,request_id,state);
CREATE UNIQUE INDEX company_peer_calls_one_pending
ON company_peer_calls(provider_instance_id,workspace_id)
WHERE state IN ('prepared','invoking','uncertain');
CREATE TRIGGER company_peer_call_identity_immutable
BEFORE UPDATE OF operation_id,provider_instance_id,workspace_id,request_id,operation,
  transition_request_digest,original_arguments_json,created_at ON company_peer_calls
BEGIN SELECT RAISE(ABORT,'immutable company peer call identity'); END;
CREATE TRIGGER company_peer_call_state_cas
BEFORE UPDATE OF state,receipt_projection_json ON company_peer_calls
WHEN NOT (
  (OLD.state='prepared' AND NEW.state IN ('invoking','found'))
  OR (OLD.state='invoking' AND NEW.state IN ('uncertain','found'))
  OR (OLD.state='uncertain' AND NEW.state='found')
)
BEGIN SELECT RAISE(ABORT,'invalid company peer call transition'); END;
CREATE TRIGGER company_peer_call_no_delete BEFORE DELETE ON company_peer_calls
BEGIN SELECT RAISE(ABORT,'retained company peer call'); END;

CREATE TABLE company_progress_evidence_outbox (
  operation_id TEXT PRIMARY KEY,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('jarvis_decision','jarvis_completion')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  evidence_digest TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
);
CREATE TRIGGER company_progress_evidence_identity_immutable
BEFORE UPDATE OF operation_id,evidence_kind,evidence_json,evidence_digest ON company_progress_evidence_outbox
BEGIN SELECT RAISE(ABORT,'immutable company progress evidence'); END;
CREATE TRIGGER company_progress_evidence_ack_once
BEFORE UPDATE OF acknowledged ON company_progress_evidence_outbox
WHEN OLD.acknowledged<>0 OR NEW.acknowledged<>1
BEGIN SELECT RAISE(ABORT,'company progress evidence acknowledgement is monotonic'); END;
CREATE TRIGGER company_progress_evidence_no_delete BEFORE DELETE ON company_progress_evidence_outbox
BEGIN SELECT RAISE(ABORT,'retained company progress evidence'); END;
