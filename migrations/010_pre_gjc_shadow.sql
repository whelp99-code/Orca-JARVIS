-- Pre-GJC shadow state. It is intentionally local-only: no endpoint, queue, or
-- dispatch target is represented here. All timestamps are RFC3339 milliseconds.
CREATE TABLE pre_gjc_progress_keys (
  key_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  purpose TEXT NOT NULL CHECK(purpose IN ('progress-signal','authority-receipt','verification','census')),
  public_key_pem TEXT NOT NULL, not_before TEXT NOT NULL, expires_at TEXT NOT NULL,
  registered_at TEXT NOT NULL, PRIMARY KEY(key_id,provider,purpose)
);
CREATE TABLE pre_gjc_key_revocations (
  key_id TEXT NOT NULL, provider TEXT NOT NULL, purpose TEXT NOT NULL, reason TEXT NOT NULL,
  revoked_at TEXT NOT NULL, PRIMARY KEY(key_id,provider,purpose)
);
CREATE TABLE pre_gjc_candidates (
  candidate_id TEXT PRIMARY KEY, worktree_selector TEXT NOT NULL, terminal_handle TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')), incarnation_id TEXT NOT NULL,
  cursor TEXT, signal_sequence TEXT NOT NULL, source_identity TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','leased','staged','deadletter','rejected')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_owner TEXT,
  lease_expires_at TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, project_id TEXT,
  created_at TEXT NOT NULL, staged_at TEXT, deadlettered_at TEXT
);
CREATE INDEX pre_gjc_candidates_fifo ON pre_gjc_candidates(state,next_attempt_at,provider,signal_sequence,created_at,candidate_id);
CREATE INDEX pre_gjc_candidates_binding ON pre_gjc_candidates(provider,terminal_handle,incarnation_id,signal_sequence);
CREATE TABLE pre_gjc_scheduler (
  project_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), max_attempts INTEGER NOT NULL,
  token_budget INTEGER NOT NULL, cache_budget INTEGER NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
  cache_used INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_report_outbox (
  report_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES pre_gjc_scheduler(project_id),
  payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','delivered','deadletter')),
  lease_owner TEXT, lease_expires_at TEXT, fencing_token INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT, receipt_json TEXT, created_at TEXT NOT NULL, deadlettered_at TEXT,
  UNIQUE(project_id,payload_digest)
);
CREATE INDEX pre_gjc_report_pending ON pre_gjc_report_outbox(state,next_attempt_at,project_id,created_at,report_id);
CREATE TABLE pre_gjc_authority_requests (
  request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES pre_gjc_scheduler(project_id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')), terminal_handle TEXT NOT NULL,
  session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, signal_event_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence > 0),
  request_digest TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','consumed','rejected','needs_input','expired')),
  receipt_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_authority_receipts (
  receipt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES pre_gjc_authority_requests(request_id),
  key_id TEXT NOT NULL, payload_json TEXT NOT NULL, signature TEXT NOT NULL, consumed_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_resume_intents (
  intent_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES pre_gjc_authority_requests(request_id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES pre_gjc_authority_receipts(receipt_id),
  project_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_handle TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  signal_event_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL,
  request_fence INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','delivered','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT, delivery_receipt_json TEXT, delivered_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_completion_evidence (
  evidence_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('focused','integration','crash_replay','cli','full','node24','census')),
  payload_json TEXT NOT NULL, signed_at TEXT NOT NULL, UNIQUE(project_id,kind)
);
CREATE TABLE pre_gjc_improvement_proposals (
  proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, telemetry_json TEXT NOT NULL,
  isolated_execution_required INTEGER NOT NULL DEFAULT 1 CHECK(isolated_execution_required=1),
  approval_request_id TEXT, state TEXT NOT NULL CHECK(state IN ('proposed','rejected')), created_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_boundary_audits (
  audit_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, aggregate_status TEXT NOT NULL,
  completion_promoted INTEGER NOT NULL CHECK(completion_promoted IN (0,1)),
  gjc_dispatched INTEGER NOT NULL CHECK(gjc_dispatched=0), created_at TEXT NOT NULL
);
CREATE TRIGGER pre_gjc_progress_keys_immutable_update BEFORE UPDATE ON pre_gjc_progress_keys BEGIN SELECT RAISE(ABORT,'immutable pre-gjc key'); END;
CREATE TRIGGER pre_gjc_progress_keys_immutable_delete BEFORE DELETE ON pre_gjc_progress_keys BEGIN SELECT RAISE(ABORT,'immutable pre-gjc key'); END;
CREATE TRIGGER pre_gjc_key_revocations_immutable_update BEFORE UPDATE ON pre_gjc_key_revocations BEGIN SELECT RAISE(ABORT,'immutable pre-gjc revocation'); END;
CREATE TRIGGER pre_gjc_key_revocations_immutable_delete BEFORE DELETE ON pre_gjc_key_revocations BEGIN SELECT RAISE(ABORT,'immutable pre-gjc revocation'); END;
CREATE TRIGGER pre_gjc_boundary_no_dispatch BEFORE INSERT ON pre_gjc_boundary_audits WHEN NEW.gjc_dispatched != 0 BEGIN SELECT RAISE(ABORT,'gjc dispatch prohibited'); END;
CREATE TRIGGER pre_gjc_proposals_only_insert BEFORE INSERT ON pre_gjc_improvement_proposals WHEN NEW.state NOT IN ('proposed','rejected') BEGIN SELECT RAISE(ABORT,'proposal state prohibited'); END;
CREATE TRIGGER pre_gjc_proposals_only_update BEFORE UPDATE OF state ON pre_gjc_improvement_proposals WHEN NEW.state NOT IN ('proposed','rejected') BEGIN SELECT RAISE(ABORT,'proposal state prohibited'); END;
CREATE TRIGGER pre_gjc_authority_receipt_immutable_update BEFORE UPDATE ON pre_gjc_authority_receipts BEGIN SELECT RAISE(ABORT,'immutable pre-gjc receipt'); END;
CREATE TRIGGER pre_gjc_authority_receipt_immutable_delete BEFORE DELETE ON pre_gjc_authority_receipts BEGIN SELECT RAISE(ABORT,'immutable pre-gjc receipt'); END;
CREATE TRIGGER pre_gjc_completion_evidence_immutable_update BEFORE UPDATE ON pre_gjc_completion_evidence BEGIN SELECT RAISE(ABORT,'immutable pre-gjc evidence'); END;
CREATE TRIGGER pre_gjc_completion_evidence_immutable_delete BEFORE DELETE ON pre_gjc_completion_evidence BEGIN SELECT RAISE(ABORT,'immutable pre-gjc evidence'); END;
CREATE TRIGGER pre_gjc_boundary_audit_immutable_update BEFORE UPDATE ON pre_gjc_boundary_audits BEGIN SELECT RAISE(ABORT,'immutable pre-gjc audit'); END;
CREATE TRIGGER pre_gjc_boundary_audit_immutable_delete BEFORE DELETE ON pre_gjc_boundary_audits BEGIN SELECT RAISE(ABORT,'immutable pre-gjc audit'); END;
