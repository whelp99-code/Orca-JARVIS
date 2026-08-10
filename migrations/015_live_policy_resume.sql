-- Policy-authorized resume is deliberately distinct from a human receipt.
-- The tables are append/transition only and retain the enable configuration
-- revision that granted the local policy authority.
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN revision INTEGER;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN config_digest TEXT;

CREATE TABLE pre_gjc_policy_resume_intents (
  intent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES pre_gjc_scheduler(project_id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_handle TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  pty_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
  signal_event_id TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES pre_gjc_candidates(candidate_id),
  candidate_fence INTEGER NOT NULL CHECK(candidate_fence > 0),
  config_revision INTEGER NOT NULL, config_digest TEXT NOT NULL, prompt_digest TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK(authorization_kind='policy'),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','delivered','blocked')),
  blocked_reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
  delivery_receipt_json TEXT, delivered_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id,provider,terminal_handle,session_id,incarnation_id,pty_id,worktree_id,signal_event_id,candidate_id)
);
CREATE INDEX pre_gjc_policy_resume_pending ON pre_gjc_policy_resume_intents(state,project_id,created_at,intent_id);
CREATE TABLE pre_gjc_policy_resume_attempts (
  intent_id TEXT PRIMARY KEY REFERENCES pre_gjc_policy_resume_intents(intent_id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_handle TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  pty_id TEXT NOT NULL, worktree_id TEXT NOT NULL, prompt_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','sending','delivered','uncertain')),
  receipt_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE pre_gjc_policy_resume_blocks (
  block_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider TEXT NOT NULL,
  terminal_handle TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  pty_id TEXT NOT NULL, worktree_id TEXT NOT NULL, signal_event_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id,provider,terminal_handle,session_id,incarnation_id,pty_id,worktree_id,signal_event_id,candidate_id)
);
CREATE TRIGGER pre_gjc_policy_resume_intents_identity_immutable BEFORE UPDATE OF project_id,provider,terminal_handle,session_id,incarnation_id,pty_id,worktree_id,signal_event_id,candidate_id,candidate_fence,config_revision,config_digest,prompt_digest,authorization_kind ON pre_gjc_policy_resume_intents BEGIN SELECT RAISE(ABORT,'immutable policy resume identity'); END;
CREATE TRIGGER pre_gjc_policy_resume_attempts_identity_immutable BEFORE UPDATE OF provider,terminal_handle,session_id,incarnation_id,pty_id,worktree_id,prompt_digest ON pre_gjc_policy_resume_attempts BEGIN SELECT RAISE(ABORT,'immutable policy resume attempt identity'); END;
CREATE TRIGGER pre_gjc_policy_resume_blocks_immutable_update BEFORE UPDATE ON pre_gjc_policy_resume_blocks BEGIN SELECT RAISE(ABORT,'immutable policy resume block'); END;
CREATE TRIGGER pre_gjc_policy_resume_blocks_immutable_delete BEFORE DELETE ON pre_gjc_policy_resume_blocks BEGIN SELECT RAISE(ABORT,'immutable policy resume block'); END;
