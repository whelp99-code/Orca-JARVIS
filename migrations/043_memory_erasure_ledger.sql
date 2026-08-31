-- Task 30 append-only erasure, export, and deletion-proof ledger.
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
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(julianday(valid_until)>julianday(valid_from))
);

CREATE TABLE memory_erasure_ledger (
  erasure_event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES memory_effect_requests(request_id),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'export_manifest','export_artifact','logical_disposition','generation_rewrite','reader_drain',
    'predecessor_disposal','physical_absence','deletion_proof','reingress_block','external_receipt'
  )),
  target_id TEXT,
  source_owner_class TEXT CHECK(source_owner_class IS NULL OR source_owner_class IN ('provider_owned','external_read_only')),
  generation_id TEXT,
  artifact_digest TEXT,
  proof_json TEXT NOT NULL,
  proof_digest TEXT NOT NULL UNIQUE,
  predecessor_disposed INTEGER CHECK(predecessor_disposed IS NULL OR predecessor_disposed IN (0,1)),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX memory_erasure_request ON memory_erasure_ledger(request_id,created_at,erasure_event_id);
CREATE UNIQUE INDEX memory_erasure_final_proof ON memory_erasure_ledger(request_id)
  WHERE event_type='deletion_proof';

CREATE TRIGGER memory_erasure_final_guard BEFORE INSERT ON memory_erasure_ledger
WHEN NEW.event_type='deletion_proof' AND (
  NEW.predecessor_disposed<>1
  OR NOT EXISTS (SELECT 1 FROM memory_erasure_ledger e WHERE e.request_id=NEW.request_id AND e.event_type='physical_absence')
  OR NOT EXISTS (SELECT 1 FROM memory_erasure_ledger e WHERE e.request_id=NEW.request_id AND e.event_type='reader_drain')
)
BEGIN SELECT RAISE(ABORT,'memory erasure proof incomplete'); END;
CREATE TRIGGER memory_provider_proof_keys_identity BEFORE UPDATE OF
  key_id,provider_instance_id,provider_release_sha,algorithm,public_key_pem,key_fingerprint,
  valid_from,valid_until,created_at ON memory_provider_proof_keys
  BEGIN SELECT RAISE(ABORT,'immutable memory provider proof key'); END;
CREATE TRIGGER memory_erasure_ledger_immutable_update BEFORE UPDATE ON memory_erasure_ledger
  BEGIN SELECT RAISE(ABORT,'immutable memory erasure ledger'); END;
CREATE TRIGGER memory_erasure_ledger_immutable_delete BEFORE DELETE ON memory_erasure_ledger
  BEGIN SELECT RAISE(ABORT,'immutable memory erasure ledger'); END;
