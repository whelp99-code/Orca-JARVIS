-- One durable candidate per existing task operation. Local measurements are not signed completion evidence.
CREATE TABLE task_candidate_artifacts (
  attempt_id TEXT PRIMARY KEY REFERENCES control_effect_attempts(attempt_id),
  candidate_digest TEXT NOT NULL CHECK(length(candidate_digest)=71),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 25165824),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=71),
  created_at TEXT NOT NULL,
  verification_json TEXT CHECK(verification_json IS NULL OR
    (json_valid(verification_json) AND length(CAST(verification_json AS BLOB))<=262144)),
  verification_digest TEXT,
  verified_at TEXT,
  CHECK((verification_json IS NULL AND verification_digest IS NULL AND verified_at IS NULL) OR
    (verification_json IS NOT NULL AND verification_digest IS NOT NULL AND length(verification_digest)=71 AND verified_at IS NOT NULL))
) WITHOUT ROWID;

CREATE TRIGGER task_candidate_replace_guard BEFORE INSERT ON task_candidate_artifacts
WHEN EXISTS(SELECT 1 FROM task_candidate_artifacts WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'task candidate already exists'); END;
CREATE TRIGGER task_candidate_insert_binding BEFORE INSERT ON task_candidate_artifacts
WHEN NEW.verification_json IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM control_effect_attempts a
  JOIN control_command_requests r ON r.request_id=a.request_id
  WHERE a.attempt_id=NEW.attempt_id AND a.effect_type='task.execute' AND a.state='invoking'
    AND r.state='claimed' AND r.lease_fence=a.lease_fence
    AND a.attempt_id=json_extract(CAST(NEW.payload AS TEXT),'$.attempt_id')
    AND a.task_plan_digest=json_extract(CAST(NEW.payload AS TEXT),'$.execution_plan_digest')
)
BEGIN SELECT RAISE(ABORT,'invoking task candidate binding required'); END;
CREATE TRIGGER task_candidate_identity_immutable
BEFORE UPDATE OF attempt_id,candidate_digest,payload,payload_digest,created_at ON task_candidate_artifacts
BEGIN SELECT RAISE(ABORT,'immutable task candidate'); END;
CREATE TRIGGER task_candidate_delete_guard BEFORE DELETE ON task_candidate_artifacts
BEGIN SELECT RAISE(ABORT,'immutable task candidate'); END;
CREATE TRIGGER task_candidate_verification_once
BEFORE UPDATE OF verification_json,verification_digest,verified_at ON task_candidate_artifacts
WHEN OLD.verification_json IS NOT NULL OR NEW.verification_json IS NULL
  OR NEW.verification_digest IS NULL OR NEW.verified_at IS NULL OR NOT EXISTS(
    SELECT 1 FROM control_effect_attempts a JOIN control_command_requests r ON r.request_id=a.request_id
    WHERE a.attempt_id=OLD.attempt_id AND a.state='invoking' AND r.state='claimed' AND r.lease_fence=a.lease_fence
  )
BEGIN SELECT RAISE(ABORT,'task candidate verification is single assignment'); END;
