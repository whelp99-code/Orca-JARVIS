CREATE TABLE memory_candidate_classifications (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:'),
  candidate_digest TEXT NOT NULL UNIQUE CHECK(length(candidate_digest)=71 AND substr(candidate_digest,1,7)='sha256:'),
  input_class TEXT NOT NULL CHECK(input_class IN (
    'explicit_user_instruction','verified_outcome','approved_decision','labeled_inference','raw_transcript',
    'worker_assertion','unverified_summary','transient_runtime','unlabeled_trait_inference','model_assertion'
  )),
  confidence TEXT NOT NULL CHECK(confidence IN ('verified','confirmed','inferred')),
  policy_sensitivity TEXT NOT NULL CHECK(policy_sensitivity IN ('public','personal','sensitive','restricted')),
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
  confirmation_gate TEXT CHECK(confirmation_gate IS NULL OR confirmation_gate='PERSONAL_MEMORY_CONFIRMATION'),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71 AND substr(policy_digest,1,7)='sha256:'),
  classification_reason TEXT NOT NULL,
  classification_digest TEXT NOT NULL UNIQUE
    CHECK(length(classification_digest)=71 AND substr(classification_digest,1,7)='sha256:'),
  dedup_key TEXT NOT NULL UNIQUE CHECK(length(dedup_key)=71 AND substr(dedup_key,1,7)='sha256:'),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  authenticated_session_id TEXT,
  worker_id TEXT,
  verifier_id TEXT,
  control_request_id TEXT,
  control_receipt_id TEXT,
  control_command_digest TEXT
    CHECK(control_command_digest IS NULL OR length(control_command_digest)=71 AND substr(control_command_digest,1,7)='sha256:'),
  inference_label TEXT CHECK(inference_label IS NULL OR inference_label='inference'),
  conflict_state TEXT NOT NULL CHECK(conflict_state IN ('none','same','conflict','supersede')),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('not_created','pending','blocked')),
  delivery_reason TEXT,
  created_at TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at
  ),
  CHECK(
    (delivery_state='not_created' AND delivery_reason IS NULL)
    OR (delivery_state='pending' AND delivery_reason='SECOND_BRAIN_NO_DATA')
    OR (delivery_state='blocked' AND delivery_reason IS NOT NULL)
  ),
  CHECK(
    input_class<>'approved_decision'
    OR control_request_id IS NOT NULL AND control_receipt_id IS NOT NULL AND control_command_digest IS NOT NULL
  ),
  CHECK(input_class<>'labeled_inference' OR inference_label='inference')
);
CREATE INDEX memory_candidate_classification_source
  ON memory_candidate_classifications(source_id,input_class,created_at,candidate_id);
CREATE INDEX memory_candidate_classification_policy
  ON memory_candidate_classifications(policy_digest,classification_reason,created_at,candidate_id);

CREATE TABLE memory_candidate_source_refs (
  candidate_id TEXT NOT NULL REFERENCES memory_candidate_classifications(candidate_id),
  position INTEGER NOT NULL CHECK(position>=0),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN (
    'verification','artifact','owner_instruction','owner_session','inference_evidence',
    'existing_memory','second_brain_conflict','transcript','unverified'
  )),
  source_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:'),
  observed_at TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at
  ),
  fresh_until TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until
  ),
  expires_at TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at
  ),
  PRIMARY KEY(candidate_id,position),
  UNIQUE(candidate_id,source_ref),
  CHECK(julianday(observed_at)<julianday(fresh_until)),
  CHECK(julianday(fresh_until)<=julianday(expires_at))
);
CREATE INDEX memory_candidate_source_ref_identity
  ON memory_candidate_source_refs(source_ref,evidence_digest,candidate_id,position);

CREATE TABLE memory_candidate_idempotency (
  idempotency_digest TEXT PRIMARY KEY
    CHECK(length(idempotency_digest)=71 AND substr(idempotency_digest,1,7)='sha256:'),
  request_digest TEXT NOT NULL UNIQUE CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:'),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:'),
  candidate_id TEXT NOT NULL REFERENCES memory_candidate_classifications(candidate_id),
  created_at TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at
  )
);
CREATE INDEX memory_candidate_idempotency_candidate
  ON memory_candidate_idempotency(candidate_id,created_at,idempotency_digest);

CREATE TRIGGER memory_candidate_classification_insert_guard
BEFORE INSERT ON memory_candidate_classifications
WHEN NOT EXISTS (
  SELECT 1 FROM memory_candidates
  WHERE candidate_id=NEW.candidate_id AND state='proposed' AND created_at=NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT,'memory candidate proposed row required');
END;

CREATE TRIGGER memory_candidate_idempotency_insert_guard
BEFORE INSERT ON memory_candidate_idempotency
WHEN NOT EXISTS (
  SELECT 1 FROM memory_candidate_classifications
  WHERE candidate_id=NEW.candidate_id AND input_digest=NEW.input_digest AND created_at=NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT,'memory candidate classification binding required');
END;

CREATE TRIGGER memory_candidate_classification_immutable_update
BEFORE UPDATE ON memory_candidate_classifications
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate classification');
END;
CREATE TRIGGER memory_candidate_classification_immutable_delete
BEFORE DELETE ON memory_candidate_classifications
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate classification');
END;
CREATE TRIGGER memory_candidate_source_ref_immutable_update
BEFORE UPDATE ON memory_candidate_source_refs
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate source reference');
END;
CREATE TRIGGER memory_candidate_source_ref_immutable_delete
BEFORE DELETE ON memory_candidate_source_refs
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate source reference');
END;
CREATE TRIGGER memory_candidate_idempotency_immutable_update
BEFORE UPDATE ON memory_candidate_idempotency
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate idempotency');
END;
CREATE TRIGGER memory_candidate_idempotency_immutable_delete
BEFORE DELETE ON memory_candidate_idempotency
BEGIN
  SELECT RAISE(ABORT,'immutable memory candidate idempotency');
END;
