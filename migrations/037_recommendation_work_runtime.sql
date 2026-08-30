CREATE TABLE recommendation_work_progress_keys (
  key_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  public_key_pem TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_verifiers (
  key_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_runtimes (
  runtime_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
  identity_json TEXT NOT NULL,
  identity_digest TEXT NOT NULL UNIQUE,
  workflow_digest TEXT NOT NULL,
  dispatch_intent_id TEXT NOT NULL UNIQUE,
  verification_request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN (
    'prepared','dispatching','dispatched','progressed','verified','recovering','blocked','failed','completed','cancelled'
  )),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  progress_sequence INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  failure_code TEXT,
  current_incarnation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_dispatch_attempts (
  attempt_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
  lease_fence INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','not_sent','accepted','uncertain')),
  event_id TEXT,
  evidence_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(runtime_id,attempt)
);
CREATE TABLE recommendation_work_dispatch_receipts (
  receipt_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_dispatch_attempts(attempt_id),
  receipt_json TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  accepted_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_progress (
  event_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
  dispatch_receipt_id TEXT NOT NULL REFERENCES recommendation_work_dispatch_receipts(receipt_id),
  sequence INTEGER NOT NULL,
  signal_json TEXT NOT NULL,
  signal_digest TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  UNIQUE(runtime_id,sequence)
);
CREATE TABLE recommendation_work_nonterminal_events (
  event_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
  kind TEXT NOT NULL CHECK(kind IN ('worker_done','idle','prompt','self_review')),
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_verification_receipts (
  receipt_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
  verification_request_id TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  decision TEXT NOT NULL CHECK(decision IN ('PASS','REJECT')),
  artifact_digest TEXT NOT NULL,
  test_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  commit_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_negative_evidence (
  evidence_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
  reason_code TEXT NOT NULL,
  evidence_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_work_settlements (
  settlement_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','cancelled')),
  settlement_json TEXT NOT NULL,
  settlement_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE recommendation_verified_outcomes (
  candidate_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TRIGGER recommendation_work_identity_immutable BEFORE UPDATE OF
  runtime_id,request_id,run_id,identity_json,identity_digest,workflow_digest,
  dispatch_intent_id,verification_request_id,created_at ON recommendation_work_runtimes
BEGIN SELECT RAISE(ABORT,'immutable recommendation work identity'); END;
CREATE TRIGGER recommendation_work_keys_immutable_update BEFORE UPDATE ON recommendation_work_progress_keys
BEGIN SELECT RAISE(ABORT,'immutable recommendation work progress key'); END;
CREATE TRIGGER recommendation_work_keys_immutable_delete BEFORE DELETE ON recommendation_work_progress_keys
BEGIN SELECT RAISE(ABORT,'immutable recommendation work progress key'); END;
CREATE TRIGGER recommendation_work_verifiers_immutable_update BEFORE UPDATE ON recommendation_work_verifiers
BEGIN SELECT RAISE(ABORT,'immutable recommendation work verifier'); END;
CREATE TRIGGER recommendation_work_verifiers_immutable_delete BEFORE DELETE ON recommendation_work_verifiers
BEGIN SELECT RAISE(ABORT,'immutable recommendation work verifier'); END;
CREATE TRIGGER recommendation_work_receipts_immutable_update BEFORE UPDATE ON recommendation_work_dispatch_receipts
BEGIN SELECT RAISE(ABORT,'immutable recommendation work dispatch receipt'); END;
CREATE TRIGGER recommendation_work_receipts_immutable_delete BEFORE DELETE ON recommendation_work_dispatch_receipts
BEGIN SELECT RAISE(ABORT,'immutable recommendation work dispatch receipt'); END;
CREATE TRIGGER recommendation_work_progress_immutable_update BEFORE UPDATE ON recommendation_work_progress
BEGIN SELECT RAISE(ABORT,'immutable recommendation work progress'); END;
CREATE TRIGGER recommendation_work_progress_immutable_delete BEFORE DELETE ON recommendation_work_progress
BEGIN SELECT RAISE(ABORT,'immutable recommendation work progress'); END;
CREATE TRIGGER recommendation_work_nonterminal_immutable_update BEFORE UPDATE ON recommendation_work_nonterminal_events
BEGIN SELECT RAISE(ABORT,'immutable recommendation work nonterminal event'); END;
CREATE TRIGGER recommendation_work_nonterminal_immutable_delete BEFORE DELETE ON recommendation_work_nonterminal_events
BEGIN SELECT RAISE(ABORT,'immutable recommendation work nonterminal event'); END;
CREATE TRIGGER recommendation_work_verification_immutable_update BEFORE UPDATE ON recommendation_work_verification_receipts
BEGIN SELECT RAISE(ABORT,'immutable recommendation work verification'); END;
CREATE TRIGGER recommendation_work_verification_immutable_delete BEFORE DELETE ON recommendation_work_verification_receipts
BEGIN SELECT RAISE(ABORT,'immutable recommendation work verification'); END;
CREATE TRIGGER recommendation_work_negative_immutable_update BEFORE UPDATE ON recommendation_work_negative_evidence
BEGIN SELECT RAISE(ABORT,'immutable recommendation work negative evidence'); END;
CREATE TRIGGER recommendation_work_negative_immutable_delete BEFORE DELETE ON recommendation_work_negative_evidence
BEGIN SELECT RAISE(ABORT,'immutable recommendation work negative evidence'); END;
CREATE TRIGGER recommendation_work_settlement_immutable_update BEFORE UPDATE ON recommendation_work_settlements
BEGIN SELECT RAISE(ABORT,'immutable recommendation work settlement'); END;
CREATE TRIGGER recommendation_work_settlement_immutable_delete BEFORE DELETE ON recommendation_work_settlements
BEGIN SELECT RAISE(ABORT,'immutable recommendation work settlement'); END;
CREATE TRIGGER recommendation_verified_outcome_immutable_update BEFORE UPDATE ON recommendation_verified_outcomes
BEGIN SELECT RAISE(ABORT,'immutable recommendation verified outcome'); END;
CREATE TRIGGER recommendation_verified_outcome_immutable_delete BEFORE DELETE ON recommendation_verified_outcomes
BEGIN SELECT RAISE(ABORT,'immutable recommendation verified outcome'); END;
