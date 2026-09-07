CREATE TABLE task_candidate_certifications (
  attempt_id TEXT PRIMARY KEY REFERENCES task_candidate_artifacts(attempt_id),
  verification_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=16384),
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','running','recorded','uncertain')),
  invocation_id TEXT,
  started_at TEXT,
  proof_json TEXT CHECK(proof_json IS NULL OR (json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=524288)),
  proof_digest TEXT,
  created_at TEXT NOT NULL,
  error_code TEXT,
  CHECK((invocation_id IS NULL AND started_at IS NULL) OR (invocation_id IS NOT NULL AND started_at IS NOT NULL)),
  CHECK((state='recorded' AND proof_json IS NOT NULL AND proof_digest IS NOT NULL) OR
    (state!='recorded' AND proof_json IS NULL AND proof_digest IS NULL)),
  CHECK(state NOT IN ('running','recorded') OR invocation_id IS NOT NULL)
) WITHOUT ROWID;
CREATE TRIGGER task_certification_replace_guard BEFORE INSERT ON task_candidate_certifications
WHEN EXISTS(SELECT 1 FROM task_candidate_certifications WHERE attempt_id=NEW.attempt_id OR verification_id=NEW.verification_id)
BEGIN SELECT RAISE(ABORT,'task certification already exists'); END;
CREATE TRIGGER task_certification_insert_binding BEFORE INSERT ON task_candidate_certifications
WHEN NEW.state!='reserved' OR NEW.invocation_id IS NOT NULL OR NEW.started_at IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM control_effect_attempts a JOIN control_command_requests r ON r.request_id=a.request_id
  WHERE a.attempt_id=NEW.attempt_id AND a.state='invoking' AND r.state='claimed' AND r.lease_fence=a.lease_fence
    AND json_extract(NEW.request_json,'$.attempt_id')=a.attempt_id
    AND json_extract(NEW.request_json,'$.request_id')=a.request_id
    AND json_extract(NEW.request_json,'$.receipt_id')=a.receipt_id
    AND json_extract(NEW.request_json,'$.fence')=a.lease_fence
    AND json_extract(NEW.request_json,'$.verification_id')=NEW.verification_id
)
BEGIN SELECT RAISE(ABORT,'task certification binding required'); END;
CREATE TRIGGER task_certification_identity_immutable
BEFORE UPDATE OF attempt_id,verification_id,request_json,request_digest,created_at ON task_candidate_certifications
BEGIN SELECT RAISE(ABORT,'immutable task certification'); END;
CREATE TRIGGER task_certification_delete_guard BEFORE DELETE ON task_candidate_certifications
BEGIN SELECT RAISE(ABORT,'immutable task certification'); END;
CREATE TRIGGER task_certification_transition BEFORE UPDATE ON task_candidate_certifications
WHEN NOT (
  (OLD.state='reserved' AND NEW.state='running' AND NEW.invocation_id IS NOT NULL AND NEW.started_at IS NOT NULL) OR
  (OLD.state='running' AND NEW.state IN ('recorded','uncertain')
    AND NEW.invocation_id=OLD.invocation_id AND NEW.started_at=OLD.started_at)
)
BEGIN SELECT RAISE(ABORT,'invalid task certification transition'); END;
