-- Isolated workboard projection only. Never insert observations into authority task/binding tables.
CREATE TABLE IF NOT EXISTS workboard_sources (
 source_key TEXT PRIMARY KEY, coverage TEXT NOT NULL DEFAULT 'unknown', warning TEXT,
 last_successful_observation TEXT
);
CREATE TABLE IF NOT EXISTS workboard_sessions (
 session_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, session_id TEXT NOT NULL,
 alias_of TEXT, FOREIGN KEY(source_key) REFERENCES workboard_sources(source_key)
);
CREATE TABLE IF NOT EXISTS workboard_attempts (
 attempt_key TEXT PRIMARY KEY, session_key TEXT NOT NULL, incarnation TEXT NOT NULL,
 FOREIGN KEY(session_key) REFERENCES workboard_sessions(session_key)
);
CREATE TABLE IF NOT EXISTS workboard_events (
 source_key TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
 sequence INTEGER NOT NULL, session_key TEXT NOT NULL, received_at TEXT NOT NULL,
 PRIMARY KEY(source_key, event_id)
);
CREATE TABLE IF NOT EXISTS workboard_works (
 work_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL,
 task_id TEXT, parent_work_id TEXT, source_key TEXT NOT NULL,
 sequence INTEGER NOT NULL, state TEXT NOT NULL, summary TEXT NOT NULL,
 evidence_ref TEXT NOT NULL, source_at TEXT NOT NULL, received_at TEXT NOT NULL,
 attempt_key TEXT NOT NULL
);
