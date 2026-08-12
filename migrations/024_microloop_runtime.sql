CREATE TABLE microloop_schedules (
  loop_name TEXT PRIMARY KEY,
  interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 1 AND 3600000),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE microloop_leases (
  loop_name TEXT PRIMARY KEY REFERENCES microloop_schedules(loop_name),
  owner TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence > 0),
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE microloop_status (
  loop_name TEXT PRIMARY KEY REFERENCES microloop_schedules(loop_name),
  cycles INTEGER NOT NULL DEFAULT 0 CHECK(cycles >= 0),
  last_started_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  last_result_json TEXT,
  updated_at TEXT NOT NULL
);
