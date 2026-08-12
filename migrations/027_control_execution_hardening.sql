CREATE TABLE control_command_revocations (
  revocation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  receipt_id TEXT REFERENCES control_command_receipts(receipt_id),
  command_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX control_command_revocations_receipt ON control_command_revocations(receipt_id);

CREATE TABLE control_effect_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  receipt_id TEXT NOT NULL REFERENCES control_command_receipts(receipt_id),
  lease_fence INTEGER NOT NULL CHECK(lease_fence > 0),
  effect_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('prepared','invoking','confirmed','uncertain')),
  receipt_json TEXT,
  receipt_digest TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX control_effect_attempts_state ON control_effect_attempts(state,updated_at,attempt_id);

ALTER TABLE workflow_transitions ADD COLUMN approval_receipt_id TEXT REFERENCES control_command_receipts(receipt_id);
CREATE INDEX workflow_transitions_approval_receipt ON workflow_transitions(approval_receipt_id);

CREATE TABLE workflow_step_approvals (
  approval_id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(step_id),
  transition_id TEXT NOT NULL UNIQUE REFERENCES workflow_transitions(transition_id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  receipt_id TEXT NOT NULL REFERENCES control_command_receipts(receipt_id),
  lease_fence INTEGER NOT NULL CHECK(lease_fence > 0),
  command_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(request_id,lease_fence),
  UNIQUE(receipt_id)
);
CREATE INDEX workflow_step_approvals_run ON workflow_step_approvals(run_id,created_at,approval_id);
CREATE INDEX workflow_step_approvals_receipt ON workflow_step_approvals(receipt_id);

CREATE TRIGGER control_command_revocations_immutable_update BEFORE UPDATE ON control_command_revocations BEGIN SELECT RAISE(ABORT,'immutable control command revocation'); END;
CREATE TRIGGER control_command_revocations_immutable_delete BEFORE DELETE ON control_command_revocations BEGIN SELECT RAISE(ABORT,'immutable control command revocation'); END;
CREATE TRIGGER control_effect_attempt_identity_immutable BEFORE UPDATE OF attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,created_at ON control_effect_attempts BEGIN SELECT RAISE(ABORT,'immutable control effect attempt identity'); END;
CREATE TRIGGER control_effect_attempts_immutable_delete BEFORE DELETE ON control_effect_attempts BEGIN SELECT RAISE(ABORT,'immutable control effect attempt'); END;
CREATE TRIGGER workflow_step_approvals_immutable_update BEFORE UPDATE ON workflow_step_approvals BEGIN SELECT RAISE(ABORT,'immutable workflow step approval'); END;
CREATE TRIGGER workflow_step_approvals_immutable_delete BEFORE DELETE ON workflow_step_approvals BEGIN SELECT RAISE(ABORT,'immutable workflow step approval'); END;
