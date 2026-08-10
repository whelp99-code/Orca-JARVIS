-- Runtime Orca identity is distinct from the signed provider session identity.
ALTER TABLE pre_gjc_authority_requests ADD COLUMN pty_id TEXT;
ALTER TABLE pre_gjc_authority_requests ADD COLUMN worktree_id TEXT;
ALTER TABLE pre_gjc_authority_requests ADD COLUMN prompt_digest TEXT;
ALTER TABLE pre_gjc_resume_intents ADD COLUMN pty_id TEXT;
ALTER TABLE pre_gjc_resume_intents ADD COLUMN worktree_id TEXT;
ALTER TABLE pre_gjc_resume_intents ADD COLUMN prompt_digest TEXT;
ALTER TABLE pre_gjc_live_resume_attempts ADD COLUMN pty_id TEXT;
ALTER TABLE pre_gjc_live_resume_attempts ADD COLUMN worktree_id TEXT;
ALTER TABLE live_supervisor_bindings ADD COLUMN pty_id TEXT;
ALTER TABLE live_supervisor_bindings ADD COLUMN worktree_id TEXT;
ALTER TABLE live_supervisor_bindings ADD COLUMN project_id TEXT;
ALTER TABLE live_supervisor_cursors ADD COLUMN projection_state TEXT;
ALTER TABLE live_supervisor_cursors ADD COLUMN observation_digest TEXT;
CREATE TABLE live_supervisor_live_resume_config (
  project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  configured_at TEXT NOT NULL
);
