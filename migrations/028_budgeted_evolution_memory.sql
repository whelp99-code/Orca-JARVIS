CREATE TABLE IF NOT EXISTS evolution_performance_records (
  task_key TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  runs INTEGER NOT NULL CHECK(runs >= 0),
  successes INTEGER NOT NULL CHECK(successes >= 0 AND successes <= runs),
  avg_score REAL NOT NULL,
  avg_cost REAL NOT NULL,
  avg_latency_ms REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_key, candidate_id)
);

CREATE INDEX IF NOT EXISTS evolution_performance_records_task_key_idx
  ON evolution_performance_records(task_key);
