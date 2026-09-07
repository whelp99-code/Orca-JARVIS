-- Read observation retries are independent of coordinator execution health.
CREATE TABLE live_observation_health (
  canonical_path TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  pty_id TEXT,
  worktree_id TEXT,
  attempt_id TEXT NOT NULL,
  cursor_before TEXT,
  state TEXT NOT NULL CHECK(state IN ('probing','healthy','unknown','unavailable','fatal')),
  consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures BETWEEN 0 AND 31),
  last_attempt_at TEXT NOT NULL,
  attempt_deadline TEXT NOT NULL,
  last_finished_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  PRIMARY KEY(canonical_path,provider,terminal_id),
  FOREIGN KEY(canonical_path,provider,terminal_id)
    REFERENCES live_supervisor_bindings(canonical_path,provider,terminal_id) ON DELETE CASCADE
);
ALTER TABLE gjc_runtime_status ADD COLUMN last_coordinator_attempt_at TEXT;
ALTER TABLE gjc_runtime_status ADD COLUMN last_coordinator_success_at TEXT;
