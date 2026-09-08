-- Metadata-only cancellation sources and immutable intents in the existing authority DB.
CREATE TABLE memory_correction_cancellation_sources (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_requests(correction_id),
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(CAST(source_json AS BLOB))<=16384)
);
CREATE TABLE memory_correction_cancellation_intents (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_cancellation_sources(correction_id),
  intent_id TEXT NOT NULL UNIQUE,
  intent_digest TEXT NOT NULL UNIQUE,
  signing_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND length(CAST(intent_json AS BLOB))<=16384),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(signing_key_id,nonce)
);
CREATE TRIGGER memory_cancellation_source_no_update BEFORE UPDATE ON memory_correction_cancellation_sources
BEGIN SELECT RAISE(ABORT,'immutable cancellation source'); END;
CREATE TRIGGER memory_cancellation_source_no_delete BEFORE DELETE ON memory_correction_cancellation_sources
BEGIN SELECT RAISE(ABORT,'immutable cancellation source'); END;
CREATE TRIGGER memory_cancellation_intent_no_update BEFORE UPDATE ON memory_correction_cancellation_intents
BEGIN SELECT RAISE(ABORT,'immutable cancellation intent'); END;
CREATE TRIGGER memory_cancellation_intent_no_delete BEFORE DELETE ON memory_correction_cancellation_intents
BEGIN SELECT RAISE(ABORT,'immutable cancellation intent'); END;
CREATE TRIGGER memory_cancellation_unsent_guard BEFORE INSERT ON memory_correction_cancellation_intents
WHEN NOT EXISTS (
  SELECT 1 FROM memory_correction_requests c JOIN memory_effect_dispatch_cursor d ON d.singleton_id=1
  WHERE c.correction_id=NEW.correction_id AND c.state='queued' AND c.dispatch_fence=0
    AND c.provider_proof_digest IS NULL AND c.purge_receipt_digest IS NULL
    AND (d.active_lane_id IS NULL OR d.active_lane_id<>c.lane_id)
    AND d.accepted_through_sequence<c.tombstone_sequence
    AND NOT EXISTS (SELECT 1 FROM memory_correction_attempts a WHERE a.correction_id=c.correction_id)
    AND json_extract(NEW.intent_json,'$.intent_id')=NEW.intent_id
    AND json_extract(NEW.intent_json,'$.intent_digest')=NEW.intent_digest
    AND json_extract(NEW.intent_json,'$.original_delegation.request_id')=c.request_id
    AND json_extract(NEW.intent_json,'$.original_envelope_digest')=c.envelope_digest
    AND json_extract(NEW.intent_json,'$.unsent_evidence.candidate_id')=c.candidate_id
    AND EXISTS (SELECT 1 FROM memory_projection_suppressions p JOIN memory_suppression_events e ON e.sequence=p.sequence
      WHERE p.projection_id=c.candidate_id AND e.event_digest=json_extract(NEW.intent_json,'$.unsent_evidence.suppression_event_digest'))
)
BEGIN SELECT RAISE(ABORT,'MEMORY_CANCELLATION_UNSENT_UNPROVED'); END;
CREATE TRIGGER memory_cancelled_correction_dispatch BEFORE UPDATE OF state ON memory_correction_requests
WHEN NEW.state='dispatching' AND EXISTS (SELECT 1 FROM memory_correction_cancellation_intents WHERE correction_id=NEW.correction_id)
BEGIN SELECT RAISE(ABORT,'MEMORY_REQUEST_CANCELLED'); END;
CREATE TRIGGER memory_cancelled_correction_attempt BEFORE INSERT ON memory_correction_attempts
WHEN EXISTS (SELECT 1 FROM memory_correction_cancellation_intents WHERE correction_id=NEW.correction_id)
BEGIN SELECT RAISE(ABORT,'MEMORY_REQUEST_CANCELLED'); END;
CREATE TRIGGER memory_cancelled_correction_cursor BEFORE UPDATE ON memory_effect_dispatch_cursor
WHEN NEW.active_lane_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM memory_correction_cancellation_intents i JOIN memory_correction_requests c ON c.correction_id=i.correction_id
  WHERE c.lane_id=NEW.active_lane_id
)
BEGIN SELECT RAISE(ABORT,'MEMORY_REQUEST_CANCELLED'); END;
