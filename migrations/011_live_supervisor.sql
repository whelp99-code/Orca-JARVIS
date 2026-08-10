-- Local-only durable state for the future live supervisor CLI wrapper.
CREATE TABLE live_supervisor_worktrees (
  canonical_path TEXT PRIMARY KEY CHECK(substr(canonical_path,1,1)='/'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER live_supervisor_worktrees_limit BEFORE INSERT ON live_supervisor_worktrees
WHEN (SELECT COUNT(*) FROM live_supervisor_worktrees) >= 5
BEGIN SELECT RAISE(ABORT,'live supervisor supports at most five worktrees'); END;
CREATE TABLE live_supervisor_bindings (
  canonical_path TEXT NOT NULL REFERENCES live_supervisor_worktrees(canonical_path),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  terminal_id TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(canonical_path,provider,terminal_id),
  UNIQUE(canonical_path,provider,terminal_id,session_id,incarnation_id)
);
CREATE TABLE live_supervisor_cursors (
  canonical_path TEXT NOT NULL, provider TEXT NOT NULL, terminal_id TEXT NOT NULL,
  session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, next_cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(canonical_path,provider,terminal_id),
  FOREIGN KEY(canonical_path,provider,terminal_id) REFERENCES live_supervisor_bindings(canonical_path,provider,terminal_id)
);
CREATE TABLE live_supervisor_authority_items (
  item_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, provider TEXT NOT NULL,
  terminal_id TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  observation_digest TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, state TEXT NOT NULL CHECK(state='pending'),
  created_at TEXT NOT NULL
);
CREATE INDEX live_supervisor_authority_pending ON live_supervisor_authority_items(canonical_path,provider,terminal_id,session_id,incarnation_id,reason,state);
CREATE TABLE live_supervisor_resume_candidates (
  candidate_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, provider TEXT NOT NULL,
  terminal_id TEXT NOT NULL, session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
  observation_digest TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state='pending'), created_at TEXT NOT NULL
);
CREATE TABLE live_supervisor_reports (
  report_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE live_supervisor_report_receipts (
  report_id TEXT PRIMARY KEY REFERENCES live_supervisor_reports(report_id), delivered_at TEXT NOT NULL
);
CREATE TRIGGER live_supervisor_reports_immutable_update BEFORE UPDATE ON live_supervisor_reports BEGIN SELECT RAISE(ABORT,'immutable live supervisor report'); END;
CREATE TRIGGER live_supervisor_reports_immutable_delete BEFORE DELETE ON live_supervisor_reports BEGIN SELECT RAISE(ABORT,'immutable live supervisor report'); END;
CREATE TRIGGER live_supervisor_report_receipts_immutable_update BEFORE UPDATE ON live_supervisor_report_receipts BEGIN SELECT RAISE(ABORT,'immutable live supervisor report receipt'); END;
CREATE TRIGGER live_supervisor_report_receipts_immutable_delete BEFORE DELETE ON live_supervisor_report_receipts BEGIN SELECT RAISE(ABORT,'immutable live supervisor report receipt'); END;
