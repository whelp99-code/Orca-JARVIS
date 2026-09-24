-- Attention facts are independent of the ingested work disposition and source observation clock.
-- A collector may update progress only on a progress signal; failed scans must not update sources.last_successful_observation.
CREATE TABLE IF NOT EXISTS workboard_attention (
 work_id TEXT PRIMARY KEY REFERENCES workboard_works(work_id),
 sequence INTEGER NOT NULL,
 last_progress_received_at TEXT,
 attempt_execution TEXT NOT NULL DEFAULT 'unknown' CHECK(attempt_execution IN ('running','waiting','stopped','unknown')),
 action_delivery TEXT NOT NULL DEFAULT 'none' CHECK(action_delivery IN ('none','cancel_requested','delivering','delivered','uncertain')),
 wait_kind TEXT CHECK(wait_kind IN ('user_decision','dependency','long_running','verification')),
 wait_reason TEXT,
 wait_started_at TEXT,
 deadline_at TEXT,
 impact INTEGER,
 decision_valid INTEGER NOT NULL DEFAULT 0 CHECK(decision_valid IN (0,1))
);
