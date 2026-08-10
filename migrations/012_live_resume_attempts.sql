-- Durable final send marker for the pre-GJC live-resume boundary.  This table
-- intentionally stores only digests, never a terminal transcript or secrets.
CREATE TABLE pre_gjc_live_resume_attempts (
  intent_id TEXT PRIMARY KEY REFERENCES pre_gjc_resume_intents(intent_id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_handle TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  prompt_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','sending','delivered','uncertain')),
  receipt_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER pre_gjc_live_resume_attempts_identity_immutable BEFORE UPDATE OF provider,terminal_handle,session_id,incarnation_id,prompt_digest ON pre_gjc_live_resume_attempts BEGIN SELECT RAISE(ABORT,'immutable live resume identity'); END;
