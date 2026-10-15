ALTER TABLE control_command_requests ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version IN (1, 2));

DROP TRIGGER control_request_identity_immutable;
CREATE TRIGGER control_request_identity_immutable
BEFORE UPDATE OF request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,schema_version
ON control_command_requests
BEGIN SELECT RAISE(ABORT,'immutable control command identity'); END;

CREATE TABLE company_approval_bindings (
  provider_instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (provider_instance_id, workspace_id)
);
CREATE TRIGGER company_approval_bindings_immutable_update
BEFORE UPDATE ON company_approval_bindings
BEGIN SELECT RAISE(ABORT,'immutable company approval binding'); END;
CREATE TRIGGER company_approval_bindings_immutable_delete
BEFORE DELETE ON company_approval_bindings
BEGIN SELECT RAISE(ABORT,'immutable company approval binding'); END;

CREATE TABLE company_freshness_checkpoints (
  provider_instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_instance_id, workspace_id)
);

CREATE TABLE company_progress_reservations (
  operation_id TEXT PRIMARY KEY,
  provider_instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  operation TEXT NOT NULL,
  reservation_id TEXT UNIQUE,
  reserve_request_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  finished_checkpoint_json TEXT,
  evidence_digest TEXT,
  terminal_state TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER company_progress_reservation_identity_immutable
BEFORE UPDATE OF operation_id,provider_instance_id,workspace_id,request_id,operation,reservation_id,reserve_request_json,checkpoint_json,created_at
ON company_progress_reservations
BEGIN SELECT RAISE(ABORT,'immutable company progress reservation identity'); END;
CREATE TRIGGER company_progress_reservation_finish_once
BEFORE UPDATE OF finished_checkpoint_json,evidence_digest,terminal_state
ON company_progress_reservations
WHEN OLD.finished_checkpoint_json IS NOT NULL
  OR OLD.evidence_digest IS NOT NULL
  OR OLD.terminal_state IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable company progress reservation result'); END;
