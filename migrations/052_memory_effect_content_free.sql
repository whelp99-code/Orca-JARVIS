-- Task 32 content-free review, dispatch, correction-spool, and derived request bindings.
CREATE TABLE memory_candidate_review_publications (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  candidate_digest TEXT NOT NULL,
  classification_digest TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 1 AND 4096),
  review_spool_digest TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE memory_candidate_dispatch_publications (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct')),
  dispatch_spool_digest TEXT NOT NULL UNIQUE,
  target_version_digest TEXT,
  expected_prior_digest TEXT,
  scope_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('published','accepted','terminal')),
  published_at TEXT NOT NULL,
  accepted_at TEXT,
  terminal_at TEXT,
  CHECK((operation='remember' AND schema_version=1 AND target_version_digest IS NULL)
    OR (operation='correct' AND schema_version=2 AND target_version_digest IS NOT NULL))
);
CREATE TABLE memory_correction_spool_claims (
  control_request_id TEXT PRIMARY KEY REFERENCES control_command_requests(request_id),
  intent_digest TEXT NOT NULL,
  semantic_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  expected_prior_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 1 AND 4096),
  spool_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('published','claimed','accepted','terminal')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  accepted_at TEXT,
  terminal_at TEXT
);
CREATE TABLE memory_effect_derived_requests (
  control_request_id TEXT PRIMARY KEY REFERENCES control_command_requests(request_id),
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget','export')),
  request_id TEXT UNIQUE,
  request_digest TEXT UNIQUE,
  envelope_digest TEXT UNIQUE,
  delegation_digest TEXT UNIQUE,
  payload_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','accepted','reconciling','completed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER memory_candidate_review_immutable_update BEFORE UPDATE ON memory_candidate_review_publications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate review publication'); END;
CREATE TRIGGER memory_candidate_review_immutable_delete BEFORE DELETE ON memory_candidate_review_publications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate review publication'); END;
CREATE TRIGGER memory_dispatch_identity_immutable BEFORE UPDATE OF candidate_id,schema_version,operation,
  dispatch_spool_digest,target_version_digest,expected_prior_digest,scope_digest,published_at
ON memory_candidate_dispatch_publications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate dispatch identity'); END;
CREATE TRIGGER memory_correction_spool_identity_immutable BEFORE UPDATE OF control_request_id,intent_digest,
  semantic_digest,target_manifest_digest,scope_digest,expected_prior_digest,content_digest,
  content_bytes,spool_digest,created_at,expires_at ON memory_correction_spool_claims
BEGIN SELECT RAISE(ABORT,'immutable memory correction spool identity'); END;
CREATE TRIGGER memory_derived_request_identity_immutable BEFORE UPDATE OF control_request_id,operation,
  payload_digest,target_manifest_digest,scope_digest,created_at ON memory_effect_derived_requests
BEGIN SELECT RAISE(ABORT,'immutable memory derived request identity'); END;
