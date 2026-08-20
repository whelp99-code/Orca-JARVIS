CREATE TABLE evolution_shadow_observations (
  observation_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('verified','verification_failed')),
  score REAL CHECK(score IS NULL OR (score >= 0 AND score <= 1)),
  cost REAL NOT NULL CHECK(cost >= 0),
  latency_ms REAL NOT NULL CHECK(latency_ms >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX evolution_shadow_observations_task
  ON evolution_shadow_observations(task_key,candidate_id,candidate_fingerprint,created_at);

CREATE TRIGGER evolution_shadow_observations_immutable_update
BEFORE UPDATE ON evolution_shadow_observations
BEGIN
  SELECT RAISE(ABORT,'immutable evolution observation');
END;

CREATE TRIGGER evolution_shadow_observations_immutable_delete
BEFORE DELETE ON evolution_shadow_observations
BEGIN
  SELECT RAISE(ABORT,'immutable evolution observation');
END;
