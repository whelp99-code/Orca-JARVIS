-- Task 30 permanent JARVIS tombstone authority and content-free preparation metadata.
CREATE TABLE memory_tombstone_chain (
  sequence INTEGER PRIMARY KEY CHECK(sequence>=1),
  tombstone_id TEXT NOT NULL UNIQUE CHECK(tombstone_id GLOB 'memtomb:v1:[0-9a-f]*' AND length(tombstone_id)=75),
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget')),
  lane_id TEXT NOT NULL UNIQUE,
  target_manifest_digest TEXT NOT NULL CHECK(target_manifest_digest GLOB 'sha256:[0-9a-f]*' AND length(target_manifest_digest)=71),
  scope_digest TEXT NOT NULL CHECK(scope_digest GLOB 'sha256:[0-9a-f]*' AND length(scope_digest)=71),
  authority_receipt_digest TEXT NOT NULL CHECK(authority_receipt_digest GLOB 'sha256:[0-9a-f]*' AND length(authority_receipt_digest)=71),
  payload_digest TEXT NOT NULL CHECK(payload_digest GLOB 'sha256:[0-9a-f]*' AND length(payload_digest)=71),
  keyed_subject_digest TEXT NOT NULL CHECK(keyed_subject_digest GLOB 'hmac-sha256:[0-9a-f]*' AND length(keyed_subject_digest)=76),
  effective_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at),
  previous_root TEXT NOT NULL CHECK(previous_root GLOB 'sha256:[0-9a-f]*' AND length(previous_root)=71),
  set_root TEXT NOT NULL UNIQUE CHECK(set_root GLOB 'sha256:[0-9a-f]*' AND length(set_root)=71),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(operation,target_manifest_digest,scope_digest,payload_digest)
);
CREATE INDEX memory_tombstone_chain_scope ON memory_tombstone_chain(scope_digest,sequence);
CREATE INDEX memory_tombstone_chain_subject ON memory_tombstone_chain(keyed_subject_digest,sequence);

CREATE TABLE memory_tombstone_delegation_links (
  sequence INTEGER PRIMARY KEY REFERENCES memory_tombstone_chain(sequence),
  delegation_digest TEXT NOT NULL UNIQUE CHECK(delegation_digest GLOB 'sha256:[0-9a-f]*' AND length(delegation_digest)=71),
  request_digest TEXT NOT NULL UNIQUE CHECK(request_digest GLOB 'sha256:[0-9a-f]*' AND length(request_digest)=71),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TABLE memory_suppressions (
  suppression_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL REFERENCES memory_tombstone_chain(sequence),
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget')),
  target_digest TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  keyed_subject_digest TEXT NOT NULL,
  source_identity_digest TEXT NOT NULL,
  content_identity_digest TEXT NOT NULL,
  citation_identity_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state='active'),
  effective_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(sequence,target_digest)
);
CREATE INDEX memory_suppression_target ON memory_suppressions(target_digest,state);
CREATE INDEX memory_suppression_subject ON memory_suppressions(keyed_subject_digest,state);
CREATE INDEX memory_suppression_source ON memory_suppressions(source_identity_digest,state);
CREATE INDEX memory_suppression_content ON memory_suppressions(content_identity_digest,state);
CREATE INDEX memory_suppression_citation ON memory_suppressions(citation_identity_digest,state);

CREATE TABLE memory_resolved_target_metadata (
  target_id TEXT PRIMARY KEY,
  target_digest TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_manifest_digest TEXT NOT NULL,
  page_content_digest TEXT NOT NULL,
  source_identity_digest TEXT NOT NULL,
  content_identity_digest TEXT NOT NULL,
  citation_identity_digest TEXT NOT NULL,
  keyed_subject_digest TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','personal','sensitive','restricted')),
  source_owner_class TEXT NOT NULL CHECK(source_owner_class IN ('provider_owned','external_read_only')),
  source_owner_id_digest TEXT NOT NULL,
  resolved_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at)=resolved_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TABLE memory_effect_preparations (
  lane_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK(lane IN ('correction','deletion','export')),
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget','export')),
  provider_instance_id TEXT NOT NULL,
  candidate_id TEXT,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  spool_locator TEXT NOT NULL UNIQUE,
  spool_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('staged','approved','consumed','expired')),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK((lane='correction' AND operation='correct') OR (lane='deletion' AND operation='forget') OR (lane='export' AND operation='export'))
);

CREATE TABLE memory_effect_delegation_keys (
  key_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL CHECK(principal_id='principal:owner'),
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  valid_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)=valid_from),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TABLE memory_external_erasure_keys (
  key_id TEXT PRIMARY KEY,
  owner_id_digest TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  valid_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)=valid_from),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TABLE memory_provider_proof_keys (
  key_id TEXT PRIMARY KEY,
  provider_instance_id TEXT NOT NULL,
  provider_release_sha TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  valid_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)=valid_from),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TABLE memory_effect_delegation_revocations (
  revocation_id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL UNIQUE,
  reason_digest TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at),
  payload_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TRIGGER memory_tombstone_chain_order BEFORE INSERT ON memory_tombstone_chain
WHEN NEW.sequence<>COALESCE((SELECT MAX(sequence)+1 FROM memory_tombstone_chain),1)
  OR NEW.previous_root<>COALESCE((SELECT set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1),'sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3')
BEGIN SELECT RAISE(ABORT,'memory tombstone chain fork'); END;
CREATE TRIGGER memory_tombstone_chain_immutable_update BEFORE UPDATE ON memory_tombstone_chain BEGIN SELECT RAISE(ABORT,'immutable memory tombstone chain'); END;
CREATE TRIGGER memory_tombstone_chain_immutable_delete BEFORE DELETE ON memory_tombstone_chain BEGIN SELECT RAISE(ABORT,'immutable memory tombstone chain'); END;
CREATE TRIGGER memory_tombstone_links_immutable_update BEFORE UPDATE ON memory_tombstone_delegation_links BEGIN SELECT RAISE(ABORT,'immutable memory tombstone delegation link'); END;
CREATE TRIGGER memory_tombstone_links_immutable_delete BEFORE DELETE ON memory_tombstone_delegation_links BEGIN SELECT RAISE(ABORT,'immutable memory tombstone delegation link'); END;
CREATE TRIGGER memory_suppressions_immutable_update BEFORE UPDATE ON memory_suppressions BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE TRIGGER memory_suppressions_immutable_delete BEFORE DELETE ON memory_suppressions BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE TRIGGER memory_resolved_target_metadata_immutable_update BEFORE UPDATE ON memory_resolved_target_metadata BEGIN SELECT RAISE(ABORT,'immutable memory target metadata'); END;
CREATE TRIGGER memory_resolved_target_metadata_immutable_delete BEFORE DELETE ON memory_resolved_target_metadata BEGIN SELECT RAISE(ABORT,'immutable memory target metadata'); END;
CREATE TRIGGER memory_effect_preparation_identity BEFORE UPDATE OF lane_id,lane,operation,provider_instance_id,candidate_id,target_manifest_digest,scope_digest,payload_digest,spool_digest,expires_at,created_at ON memory_effect_preparations BEGIN SELECT RAISE(ABORT,'immutable memory effect preparation'); END;
CREATE TRIGGER memory_effect_preparation_transition BEFORE UPDATE OF state ON memory_effect_preparations WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('staged:approved','approved:consumed','staged:expired','approved:expired') BEGIN SELECT RAISE(ABORT,'memory effect preparation transition invalid'); END;
CREATE TRIGGER memory_effect_key_identity BEFORE UPDATE OF key_id,principal_id,algorithm,public_key_pem,key_fingerprint,valid_from,valid_until,created_at ON memory_effect_delegation_keys BEGIN SELECT RAISE(ABORT,'immutable memory effect key'); END;
CREATE TRIGGER memory_external_key_identity BEFORE UPDATE OF key_id,owner_id_digest,algorithm,public_key_pem,key_fingerprint,valid_from,valid_until,created_at ON memory_external_erasure_keys BEGIN SELECT RAISE(ABORT,'immutable memory external key'); END;
CREATE TRIGGER memory_provider_key_identity BEFORE UPDATE OF key_id,provider_instance_id,provider_release_sha,algorithm,public_key_pem,key_fingerprint,valid_from,valid_until,created_at ON memory_provider_proof_keys BEGIN SELECT RAISE(ABORT,'immutable memory provider key'); END;
CREATE TRIGGER memory_effect_revocation_immutable_update BEFORE UPDATE ON memory_effect_delegation_revocations BEGIN SELECT RAISE(ABORT,'immutable memory delegation revocation'); END;
CREATE TRIGGER memory_effect_revocation_immutable_delete BEFORE DELETE ON memory_effect_delegation_revocations BEGIN SELECT RAISE(ABORT,'immutable memory delegation revocation'); END;
