-- Durable admission record; no invented memory target is needed for empty reports.
CREATE TABLE native_evening_publications (
  run_id TEXT PRIMARY KEY REFERENCES daily_loop_runs(run_id),
  step_id TEXT NOT NULL UNIQUE REFERENCES daily_loop_steps(step_id),
  artifact_id TEXT NOT NULL UNIQUE,
  canonical_digest TEXT NOT NULL,
  published_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',published_at)=published_at)
);
CREATE TRIGGER native_evening_publications_no_update
BEFORE UPDATE ON native_evening_publications BEGIN
  SELECT RAISE(ABORT,'native evening publication is immutable');
END;
CREATE TRIGGER native_evening_publications_no_delete
BEFORE DELETE ON native_evening_publications BEGIN
  SELECT RAISE(ABORT,'native evening publication is immutable');
END;
