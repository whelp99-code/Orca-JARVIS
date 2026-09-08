-- Provider-local cancellation results; not local compaction or cursor completion.
CREATE TABLE memory_correction_cancellation_results (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_cancellation_intents(correction_id),
  result_id TEXT NOT NULL UNIQUE,
  result_digest TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  provider_release_sha TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=16384),
  recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at)
);
CREATE TRIGGER memory_cancellation_result_no_update BEFORE UPDATE ON memory_correction_cancellation_results
BEGIN SELECT RAISE(ABORT,'immutable cancellation result'); END;
CREATE TRIGGER memory_cancellation_result_no_delete BEFORE DELETE ON memory_correction_cancellation_results
BEGIN SELECT RAISE(ABORT,'immutable cancellation result'); END;
CREATE TRIGGER memory_cancellation_result_binding BEFORE INSERT ON memory_correction_cancellation_results
WHEN NOT EXISTS (
  SELECT 1 FROM memory_correction_cancellation_intents i
  JOIN memory_correction_requests c ON c.correction_id=i.correction_id
  WHERE i.correction_id=NEW.correction_id
    AND json_extract(NEW.result_json,'$.kind')='memory_correction_cancellation_result'
    AND json_extract(NEW.result_json,'$.state')='provider_local_suppressed'
    AND json_extract(NEW.result_json,'$.intent_id')=i.intent_id
    AND json_extract(NEW.result_json,'$.intent_digest')=i.intent_digest
    AND json_extract(NEW.result_json,'$.original_request_id')=c.request_id
    AND json_extract(NEW.result_json,'$.original_envelope_digest')=c.envelope_digest
    AND json_extract(NEW.result_json,'$.result_id')=NEW.result_id
    AND json_extract(NEW.result_json,'$.result_digest')=NEW.result_digest
    AND json_extract(NEW.result_json,'$.provider_instance_id')=NEW.provider_instance_id
    AND c.provider_instance_id=NEW.provider_instance_id
    AND json_extract(NEW.result_json,'$.provider_release_sha')=NEW.provider_release_sha
    AND json_extract(NEW.result_json,'$.signing_key_id')=NEW.signing_key_id
    AND json_extract(NEW.result_json,'$.tombstone_sequence')=c.tombstone_sequence
    AND json_extract(NEW.result_json,'$.tombstone_set_root')=c.tombstone_set_root
)
BEGIN SELECT RAISE(ABORT,'MEMORY_CANCELLATION_RESULT_BINDING_INVALID'); END;
