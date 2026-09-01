-- Task 32 owner decisions, semantic attempts, membership, suppression, and privacy epoch.
CREATE TABLE memory_surface_authority (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  suppression_sequence INTEGER NOT NULL CHECK(suppression_sequence>=0),
  suppression_root TEXT NOT NULL,
  policy_digest TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO memory_surface_authority VALUES(
  1,0,0,'sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3',
  NULL,'1970-01-01T00:00:00.000Z'
);
CREATE TABLE memory_surface_target_versions (
  target_version_digest TEXT PRIMARY KEY,
  provider_instance_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_manifest_digest TEXT NOT NULL,
  expected_prior_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  source_membership_hmac TEXT NOT NULL,
  content_membership_hmac TEXT NOT NULL,
  citation_membership_hmac TEXT NOT NULL,
  record_membership_hmac TEXT NOT NULL,
  membership_digest TEXT NOT NULL UNIQUE,
  suppression_epoch INTEGER NOT NULL CHECK(suppression_epoch>=0),
  created_at TEXT NOT NULL
);
CREATE TABLE memory_surface_suppressions (
  sequence INTEGER PRIMARY KEY,
  suppression_root TEXT NOT NULL UNIQUE,
  previous_root TEXT NOT NULL,
  target_version_digest TEXT NOT NULL REFERENCES memory_surface_target_versions(target_version_digest),
  membership_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget')),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  command_digest TEXT NOT NULL,
  effective_at TEXT NOT NULL
);
CREATE TABLE memory_surface_semantic_families (
  family_digest TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget','export')),
  target_version_digest TEXT NOT NULL REFERENCES memory_surface_target_versions(target_version_digest),
  expected_prior_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_surface_effect_attempts (
  attempt_id TEXT PRIMARY KEY,
  family_digest TEXT NOT NULL REFERENCES memory_surface_semantic_families(family_digest),
  attempt_generation INTEGER NOT NULL CHECK(attempt_generation>=1),
  fresh_selection_digest TEXT NOT NULL UNIQUE,
  predecessor_attempt_id TEXT UNIQUE REFERENCES memory_surface_effect_attempts(attempt_id),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  state TEXT NOT NULL CHECK(state IN ('staged','approved','claimed','reconciling','receipt_rejected',
    'expired','completed','failed','uncertain','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(family_digest,attempt_generation)
);
CREATE UNIQUE INDEX memory_surface_one_active_attempt ON memory_surface_effect_attempts(family_digest)
WHERE state IN ('staged','approved','claimed','reconciling');
CREATE TABLE memory_candidate_decision_families (
  family_digest TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  candidate_digest TEXT NOT NULL,
  classification_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('confirm','reject')),
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_candidate_decision_attempts (
  attempt_id TEXT PRIMARY KEY,
  family_digest TEXT NOT NULL REFERENCES memory_candidate_decision_families(family_digest),
  attempt_generation INTEGER NOT NULL CHECK(attempt_generation>=1),
  fresh_selection_digest TEXT NOT NULL UNIQUE,
  predecessor_attempt_id TEXT UNIQUE REFERENCES memory_candidate_decision_attempts(attempt_id),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  state TEXT NOT NULL CHECK(state IN ('staged','approved','receipt_rejected','expired','applied')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(family_digest,attempt_generation)
);
CREATE UNIQUE INDEX memory_candidate_one_active_decision ON memory_candidate_decision_attempts(family_digest)
WHERE state IN ('staged','approved');
CREATE TABLE memory_candidate_owner_decisions (
  decision_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES memory_candidate_decision_attempts(attempt_id),
  decision TEXT NOT NULL CHECK(decision IN ('confirm','reject')),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  command_digest TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TRIGGER memory_target_version_immutable BEFORE UPDATE ON memory_surface_target_versions
BEGIN SELECT RAISE(ABORT,'immutable memory target version'); END;
CREATE TRIGGER memory_target_version_delete BEFORE DELETE ON memory_surface_target_versions
BEGIN SELECT RAISE(ABORT,'immutable memory target version'); END;
CREATE TRIGGER memory_surface_suppression_immutable BEFORE UPDATE ON memory_surface_suppressions
BEGIN SELECT RAISE(ABORT,'immutable memory surface suppression'); END;
CREATE TRIGGER memory_surface_suppression_delete BEFORE DELETE ON memory_surface_suppressions
BEGIN SELECT RAISE(ABORT,'immutable memory surface suppression'); END;
CREATE TRIGGER memory_candidate_decision_immutable BEFORE UPDATE ON memory_candidate_owner_decisions
BEGIN SELECT RAISE(ABORT,'immutable memory candidate owner decision'); END;
CREATE TRIGGER memory_candidate_decision_delete BEFORE DELETE ON memory_candidate_owner_decisions
BEGIN SELECT RAISE(ABORT,'immutable memory candidate owner decision'); END;
