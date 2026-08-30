CREATE TABLE memory_candidate_classifications (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
  identity_source_digest TEXT NOT NULL CHECK(
    length(identity_source_digest)=71 AND substr(identity_source_digest,1,7)='sha256:'
    AND substr(identity_source_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_digest TEXT NOT NULL UNIQUE CHECK(
    length(candidate_digest)=71 AND substr(candidate_digest,1,7)='sha256:'
    AND substr(candidate_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  input_class TEXT NOT NULL CHECK(input_class IN (
    'explicit_user_instruction','verified_outcome','approved_decision','labeled_inference','raw_transcript',
    'worker_assertion','unverified_summary','transient_runtime','unlabeled_trait_inference','model_assertion'
  )),
  confidence TEXT NOT NULL CHECK(confidence IN ('verified','confirmed','inferred')),
  policy_sensitivity TEXT NOT NULL CHECK(policy_sensitivity IN ('public','personal','sensitive','restricted')),
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
  confirmation_gate TEXT CHECK(confirmation_gate IS NULL OR confirmation_gate='PERSONAL_MEMORY_CONFIRMATION'),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71 AND substr(policy_digest,1,7)='sha256:' AND substr(policy_digest,8) NOT GLOB '*[^0-9a-f]*'),
  classification_reason TEXT NOT NULL,
  classification_digest TEXT NOT NULL UNIQUE CHECK(
    length(classification_digest)=71 AND substr(classification_digest,1,7)='sha256:'
    AND substr(classification_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  dedup_key TEXT NOT NULL UNIQUE CHECK(length(dedup_key)=71 AND substr(dedup_key,1,7)='sha256:' AND substr(dedup_key,8) NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_version TEXT NOT NULL CHECK(length(source_version) BETWEEN 1 AND 128 AND source_version NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_principal TEXT NOT NULL,
  authenticated_session_digest TEXT CHECK(
    authenticated_session_digest IS NULL OR length(authenticated_session_digest)=71
    AND substr(authenticated_session_digest,1,7)='sha256:'
    AND substr(authenticated_session_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  worker_id TEXT,
  worker_session_digest TEXT CHECK(
    worker_session_digest IS NULL OR length(worker_session_digest)=71
    AND substr(worker_session_digest,1,7)='sha256:'
    AND substr(worker_session_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_id TEXT,
  instruction_id TEXT,
  outcome_id TEXT,
  attempt_id TEXT,
  verification_evidence_id TEXT,
  control_request_id TEXT,
  control_receipt_id TEXT,
  control_command_digest TEXT CHECK(
    control_command_digest IS NULL OR length(control_command_digest)=71
    AND substr(control_command_digest,1,7)='sha256:'
    AND substr(control_command_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  authority_key_id TEXT,
  authority_expires_at TEXT CHECK(
    authority_expires_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ',authority_expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authority_expires_at)=authority_expires_at
  ),
  inference_id TEXT,
  inference_label TEXT CHECK(inference_label IS NULL OR inference_label='inference'),
  conflict_state TEXT NOT NULL CHECK(conflict_state IN ('none','same','conflict','supersede')),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('not_created','pending','blocked')),
  delivery_reason TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(
    (delivery_state='not_created' AND delivery_reason IS NULL)
    OR (delivery_state='pending' AND delivery_reason='SECOND_BRAIN_NO_DATA')
    OR (delivery_state='blocked' AND delivery_reason IS NOT NULL)
  ),
  CHECK(input_class<>'explicit_user_instruction' OR classification_reason<>'EXPLICIT_OWNER_INSTRUCTION_APPROVED' OR (
    control_request_id IS NOT NULL AND control_receipt_id IS NOT NULL AND control_command_digest IS NOT NULL
    AND authenticated_session_digest IS NOT NULL AND instruction_id IS NOT NULL AND authority_key_id IS NOT NULL
    AND authority_expires_at IS NOT NULL
  )),
  CHECK(input_class<>'verified_outcome' OR classification_reason<>'VERIFIED_OUTCOME_APPROVED' OR (
    verification_evidence_id IS NOT NULL AND worker_id IS NOT NULL AND worker_session_digest IS NOT NULL
    AND verifier_id IS NOT NULL AND outcome_id IS NOT NULL AND attempt_id IS NOT NULL AND authority_key_id IS NOT NULL
    AND authority_expires_at IS NOT NULL
  )),
  CHECK(input_class<>'approved_decision' OR classification_reason<>'APPROVED_DECISION_APPROVED' OR (
    control_request_id IS NOT NULL AND control_receipt_id IS NOT NULL AND control_command_digest IS NOT NULL
    AND authenticated_session_digest IS NOT NULL AND outcome_id IS NOT NULL AND authority_key_id IS NOT NULL
    AND authority_expires_at IS NOT NULL
  )),
  CHECK(input_class<>'labeled_inference' OR inference_id IS NOT NULL AND inference_label='inference')
);
CREATE INDEX memory_candidate_classification_source ON memory_candidate_classifications(source_id,input_class,created_at,candidate_id);
CREATE INDEX memory_candidate_classification_policy ON memory_candidate_classifications(policy_digest,classification_reason,created_at,candidate_id);

CREATE TABLE memory_candidate_source_refs (
  candidate_id TEXT NOT NULL REFERENCES memory_candidate_classifications(candidate_id),
  position INTEGER NOT NULL CHECK(position>=0),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN (
    'verification','artifact','owner_instruction','owner_session','inference_evidence',
    'existing_memory','second_brain_conflict','transcript','unverified'
  )),
  ref_namespace TEXT NOT NULL CHECK(ref_namespace IN (
    'control_command','control_receipt','verification_authority','verification_artifact',
    'inference_evidence','memory_candidate','second_brain_conflict','rejected_input'
  )),
  ref_id TEXT NOT NULL CHECK(length(ref_id)=64 AND ref_id NOT GLOB '*[^0-9a-f]*'),
  ref_version INTEGER NOT NULL CHECK(ref_version=1),
  evidence_digest TEXT NOT NULL CHECK(
    length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:'
    AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  fresh_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  PRIMARY KEY(candidate_id,position),
  UNIQUE(candidate_id,ref_kind,ref_namespace,ref_id,ref_version),
  CHECK(julianday(observed_at)<julianday(fresh_until)),
  CHECK(julianday(fresh_until)<=julianday(expires_at)),
  CHECK(
    (ref_kind='verification' AND ref_namespace IN ('control_command','verification_authority'))
    OR (ref_kind='artifact' AND ref_namespace IN ('control_receipt','verification_artifact'))
    OR (ref_kind='owner_instruction' AND ref_namespace='control_command')
    OR (ref_kind='owner_session' AND ref_namespace='control_receipt')
    OR (ref_kind='inference_evidence' AND ref_namespace='inference_evidence')
    OR (ref_kind='existing_memory' AND ref_namespace='memory_candidate')
    OR (ref_kind='second_brain_conflict' AND ref_namespace='second_brain_conflict')
    OR (ref_kind IN ('transcript','unverified') AND ref_namespace='rejected_input')
  )
);
CREATE INDEX memory_candidate_source_ref_identity ON memory_candidate_source_refs(ref_namespace,ref_id,ref_version,evidence_digest,candidate_id,position);

CREATE TABLE memory_candidate_idempotency (
  idempotency_digest TEXT PRIMARY KEY CHECK(
    length(idempotency_digest)=71 AND substr(idempotency_digest,1,7)='sha256:'
    AND substr(idempotency_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL UNIQUE CHECK(
    length(request_digest)=71 AND substr(request_digest,1,7)='sha256:'
    AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
  candidate_id TEXT NOT NULL REFERENCES memory_candidate_classifications(candidate_id),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX memory_candidate_idempotency_candidate ON memory_candidate_idempotency(candidate_id,created_at,idempotency_digest);

CREATE TABLE memory_candidate_verification_authority (
  evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) BETWEEN 1 AND 128 AND evidence_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  candidate_id TEXT NOT NULL UNIQUE CHECK(
    length(candidate_id)=79 AND substr(candidate_id,1,15)='memcand:pos:v1:'
    AND substr(candidate_id,16) NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_id TEXT NOT NULL UNIQUE CHECK(
    length(correlation_id)=76 AND substr(correlation_id,1,12)='corr:memory:'
    AND substr(correlation_id,13) NOT GLOB '*[^0-9a-f]*'
  ),
  principal_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_version TEXT NOT NULL CHECK(length(source_version) BETWEEN 1 AND 128 AND source_version NOT GLOB '*[^A-Za-z0-9_-]*'),
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=71 AND substr(subject_digest,1,7)='sha256:' AND substr(subject_digest,8) NOT GLOB '*[^0-9a-f]*'),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct')),
  purpose TEXT NOT NULL CHECK(purpose='personal_memory'),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','personal','sensitive','restricted')),
  outcome_id TEXT NOT NULL CHECK(length(outcome_id) BETWEEN 1 AND 128 AND outcome_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  outcome TEXT NOT NULL CHECK(outcome='succeeded'),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128 AND attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 128 AND worker_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  worker_session_id TEXT NOT NULL CHECK(length(worker_session_id) BETWEEN 1 AND 128 AND worker_session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  verifier_id TEXT NOT NULL CHECK(length(verifier_id) BETWEEN 1 AND 128 AND verifier_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  verifier_key_id TEXT NOT NULL CHECK(length(verifier_key_id) BETWEEN 1 AND 128 AND verifier_key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) BETWEEN 1 AND 128 AND artifact_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  evidence_digest TEXT NOT NULL CHECK(
    length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:'
    AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at)=issued_at),
  not_before TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',not_before) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',not_before)=not_before),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce) BETWEEN 1 AND 128 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  max_uses INTEGER NOT NULL CHECK(max_uses=1),
  status TEXT NOT NULL CHECK(status='issued'),
  signer_key_id TEXT NOT NULL REFERENCES trusted_authority_keys(key_id),
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(verifier_key_id=signer_key_id),
  CHECK(julianday(issued_at)<=julianday(not_before) AND julianday(not_before)<julianday(expires_at)),
  CHECK(worker_id<>verifier_id)
);

CREATE TABLE memory_candidate_authority_claims (
  authority_kind TEXT NOT NULL CHECK(authority_kind IN ('explicit_instruction','approved_decision','verified_outcome')),
  authority_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidate_classifications(candidate_id),
  classification_digest TEXT NOT NULL CHECK(
    length(classification_digest)=71 AND substr(classification_digest,1,7)='sha256:'
    AND substr(classification_digest,8) NOT GLOB '*[^0-9a-f]*'
  ),
  claimed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at)=claimed_at),
  PRIMARY KEY(authority_kind,authority_id)
);

CREATE TRIGGER memory_candidate_classification_insert_guard BEFORE INSERT ON memory_candidate_classifications
WHEN NOT EXISTS (SELECT 1 FROM memory_candidates WHERE candidate_id=NEW.candidate_id AND state='proposed' AND created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'memory candidate proposed row required'); END;
CREATE TRIGGER memory_candidate_idempotency_insert_guard BEFORE INSERT ON memory_candidate_idempotency
WHEN NOT EXISTS (
  SELECT 1 FROM memory_candidate_classifications
  WHERE candidate_id=NEW.candidate_id AND input_digest=NEW.input_digest AND created_at=NEW.created_at
)
BEGIN SELECT RAISE(ABORT,'memory candidate classification binding required'); END;
CREATE TRIGGER memory_verification_authority_key_guard BEFORE INSERT ON memory_candidate_verification_authority
WHEN NOT EXISTS (SELECT 1 FROM authority_key_purposes WHERE key_id=NEW.signer_key_id AND purpose='verifier')
BEGIN SELECT RAISE(ABORT,'memory verification authority key required'); END;
CREATE TRIGGER memory_candidate_authority_claim_guard BEFORE INSERT ON memory_candidate_authority_claims
WHEN NOT EXISTS (
  SELECT 1 FROM memory_candidate_classifications
  WHERE candidate_id=NEW.candidate_id AND classification_digest=NEW.classification_digest AND created_at=NEW.claimed_at
) OR (
  NEW.authority_kind='verified_outcome'
  AND NOT EXISTS (SELECT 1 FROM memory_candidate_verification_authority WHERE evidence_id=NEW.authority_id)
) OR (
  NEW.authority_kind IN ('explicit_instruction','approved_decision')
  AND NOT EXISTS (SELECT 1 FROM control_command_requests WHERE request_id=NEW.authority_id AND state='approved')
)
BEGIN SELECT RAISE(ABORT,'memory candidate authority binding required'); END;

CREATE TRIGGER memory_candidate_classification_immutable_update BEFORE UPDATE ON memory_candidate_classifications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate classification'); END;
CREATE TRIGGER memory_candidate_classification_immutable_delete BEFORE DELETE ON memory_candidate_classifications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate classification'); END;
CREATE TRIGGER memory_candidate_source_ref_immutable_update BEFORE UPDATE ON memory_candidate_source_refs
BEGIN SELECT RAISE(ABORT,'immutable memory candidate source reference'); END;
CREATE TRIGGER memory_candidate_source_ref_immutable_delete BEFORE DELETE ON memory_candidate_source_refs
BEGIN SELECT RAISE(ABORT,'immutable memory candidate source reference'); END;
CREATE TRIGGER memory_candidate_idempotency_immutable_update BEFORE UPDATE ON memory_candidate_idempotency
BEGIN SELECT RAISE(ABORT,'immutable memory candidate idempotency'); END;
CREATE TRIGGER memory_candidate_idempotency_immutable_delete BEFORE DELETE ON memory_candidate_idempotency
BEGIN SELECT RAISE(ABORT,'immutable memory candidate idempotency'); END;
CREATE TRIGGER memory_verification_authority_immutable_update BEFORE UPDATE ON memory_candidate_verification_authority
BEGIN SELECT RAISE(ABORT,'immutable memory verification authority'); END;
CREATE TRIGGER memory_verification_authority_immutable_delete BEFORE DELETE ON memory_candidate_verification_authority
BEGIN SELECT RAISE(ABORT,'immutable memory verification authority'); END;
CREATE TRIGGER memory_candidate_authority_claim_immutable_update BEFORE UPDATE ON memory_candidate_authority_claims
BEGIN SELECT RAISE(ABORT,'immutable memory candidate authority claim'); END;
CREATE TRIGGER memory_candidate_authority_claim_immutable_delete BEFORE DELETE ON memory_candidate_authority_claims
BEGIN SELECT RAISE(ABORT,'immutable memory candidate authority claim'); END;
