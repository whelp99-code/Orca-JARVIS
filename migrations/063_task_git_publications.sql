CREATE TABLE task_git_publications (
  attempt_id TEXT PRIMARY KEY REFERENCES task_candidate_artifacts(attempt_id),
  publication_id TEXT NOT NULL UNIQUE,
  verification_id TEXT NOT NULL REFERENCES task_candidate_certifications(verification_id),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=16384),
  binding_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('building','prepared','published','uncertain')),
  tree_oid TEXT,
  commit_oid TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  error_code TEXT,
  CHECK((tree_oid IS NULL AND commit_oid IS NULL) OR (tree_oid IS NOT NULL AND commit_oid IS NOT NULL)),
  CHECK(state NOT IN ('prepared','published') OR commit_oid IS NOT NULL),
  CHECK((state='published' AND published_at IS NOT NULL) OR (state!='published' AND published_at IS NULL))
) WITHOUT ROWID;
CREATE TRIGGER task_publication_replace_guard BEFORE INSERT ON task_git_publications
WHEN EXISTS(SELECT 1 FROM task_git_publications WHERE attempt_id=NEW.attempt_id OR publication_id=NEW.publication_id)
BEGIN SELECT RAISE(ABORT,'task publication already exists'); END;
CREATE TRIGGER task_publication_insert_guard BEFORE INSERT ON task_git_publications
WHEN NEW.state!='building' OR NEW.commit_oid IS NOT NULL OR NEW.tree_oid IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM control_effect_attempts a JOIN control_command_requests r ON r.request_id=a.request_id
  JOIN task_candidate_certifications c ON c.attempt_id=a.attempt_id
  WHERE a.attempt_id=NEW.attempt_id AND a.state='invoking' AND r.state='claimed' AND r.lease_fence=a.lease_fence
    AND c.state='recorded' AND c.verification_id=NEW.verification_id
    AND json_extract(NEW.binding_json,'$.request_id')=a.request_id
    AND json_extract(NEW.binding_json,'$.receipt_id')=a.receipt_id
    AND json_extract(NEW.binding_json,'$.fence')=a.lease_fence
    AND json_extract(NEW.binding_json,'$.proof_digest')=c.proof_digest
)
BEGIN SELECT RAISE(ABORT,'task publication binding required'); END;
CREATE TRIGGER task_publication_identity_immutable
BEFORE UPDATE OF attempt_id,publication_id,verification_id,binding_json,binding_digest,created_at ON task_git_publications
BEGIN SELECT RAISE(ABORT,'immutable task publication'); END;
CREATE TRIGGER task_publication_delete_guard BEFORE DELETE ON task_git_publications
BEGIN SELECT RAISE(ABORT,'immutable task publication'); END;
CREATE TRIGGER task_publication_transition BEFORE UPDATE ON task_git_publications
WHEN NOT (
  (OLD.state='building' AND NEW.state='prepared' AND NEW.commit_oid IS NOT NULL AND NEW.tree_oid IS NOT NULL) OR
  (OLD.state='building' AND NEW.state='uncertain' AND NEW.commit_oid IS NULL AND NEW.tree_oid IS NULL) OR
  (OLD.state='prepared' AND NEW.state IN ('published','uncertain') AND NEW.commit_oid=OLD.commit_oid AND NEW.tree_oid=OLD.tree_oid)
)
BEGIN SELECT RAISE(ABORT,'invalid task publication transition'); END;
