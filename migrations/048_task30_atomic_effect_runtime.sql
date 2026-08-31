-- Task 30 atomic destructive preparation, ordered dispatch, and durable JARVIS barriers.
ALTER TABLE memory_effect_preparations ADD COLUMN effective_at TEXT
  CHECK(effective_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at);
ALTER TABLE memory_effect_preparations ADD COLUMN provider_tombstone_sequence INTEGER
  CHECK(provider_tombstone_sequence IS NULL OR provider_tombstone_sequence>=0);
ALTER TABLE memory_effect_preparations ADD COLUMN provider_tombstone_set_root TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN request_tombstone_sequence INTEGER
  CHECK(request_tombstone_sequence IS NULL OR request_tombstone_sequence>=1);
ALTER TABLE memory_effect_preparations ADD COLUMN request_tombstone_set_root TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN request_id TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN request_digest TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN envelope_digest TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN provider_idempotency_key TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN delegation_id TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN delegation_digest TEXT;
ALTER TABLE memory_effect_preparations ADD COLUMN prepared_at TEXT
  CHECK(prepared_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',prepared_at)=prepared_at);

CREATE UNIQUE INDEX memory_effect_preparation_request_id
  ON memory_effect_preparations(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX memory_effect_preparation_request_digest
  ON memory_effect_preparations(request_digest) WHERE request_digest IS NOT NULL;
CREATE UNIQUE INDEX memory_effect_preparation_envelope_digest
  ON memory_effect_preparations(envelope_digest) WHERE envelope_digest IS NOT NULL;
CREATE UNIQUE INDEX memory_effect_preparation_provider_idempotency
  ON memory_effect_preparations(provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX memory_effect_preparation_delegation_id
  ON memory_effect_preparations(delegation_id) WHERE delegation_id IS NOT NULL;
CREATE UNIQUE INDEX memory_effect_preparation_delegation_digest
  ON memory_effect_preparations(delegation_digest) WHERE delegation_digest IS NOT NULL;

CREATE TABLE memory_effect_dispatch_cursor (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  fence INTEGER NOT NULL CHECK(fence>=0),
  active_lane_id TEXT UNIQUE REFERENCES memory_effect_preparations(lane_id),
  active_lane TEXT CHECK(active_lane IS NULL OR active_lane IN ('correction','deletion')),
  active_sequence INTEGER CHECK(active_sequence IS NULL OR active_sequence>=1),
  active_request_digest TEXT,
  accepted_through_sequence INTEGER NOT NULL CHECK(accepted_through_sequence>=0),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK((active_lane_id IS NULL)=(active_lane IS NULL)),
  CHECK((active_lane_id IS NULL)=(active_sequence IS NULL)),
  CHECK((active_lane_id IS NULL)=(active_request_digest IS NULL))
);
INSERT INTO memory_effect_dispatch_cursor(
  singleton_id,fence,active_lane_id,active_lane,active_sequence,
  active_request_digest,accepted_through_sequence,updated_at
) VALUES(1,0,NULL,NULL,NULL,NULL,0,'1970-01-01T00:00:00.000Z');

CREATE TABLE memory_lifecycle_barrier_events (
  event_id TEXT PRIMARY KEY,
  barrier_id TEXT NOT NULL CHECK(barrier_id IN (
    'jarvis_suppression_tombstone_commit',
    'jarvis_proof_observation',
    'before_settlement_commit'
  )),
  lane_id TEXT NOT NULL,
  request_id TEXT,
  tombstone_sequence INTEGER,
  event_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(barrier_id,lane_id,request_id)
);

CREATE TRIGGER memory_effect_prepared_identity
BEFORE UPDATE OF effective_at,provider_tombstone_sequence,provider_tombstone_set_root,
  request_tombstone_sequence,request_tombstone_set_root,request_id,request_digest,
  envelope_digest,provider_idempotency_key,delegation_id,delegation_digest,prepared_at
ON memory_effect_preparations
WHEN OLD.request_id IS NOT NULL AND (
  OLD.effective_at IS NOT NEW.effective_at
  OR OLD.provider_tombstone_sequence IS NOT NEW.provider_tombstone_sequence
  OR OLD.provider_tombstone_set_root IS NOT NEW.provider_tombstone_set_root
  OR OLD.request_tombstone_sequence IS NOT NEW.request_tombstone_sequence
  OR OLD.request_tombstone_set_root IS NOT NEW.request_tombstone_set_root
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.request_digest IS NOT NEW.request_digest
  OR OLD.envelope_digest IS NOT NEW.envelope_digest
  OR OLD.provider_idempotency_key IS NOT NEW.provider_idempotency_key
  OR OLD.delegation_id IS NOT NEW.delegation_id
  OR OLD.delegation_digest IS NOT NEW.delegation_digest
  OR OLD.prepared_at IS NOT NEW.prepared_at
)
BEGIN
  SELECT RAISE(ABORT,'immutable prepared memory effect identity');
END;

CREATE TRIGGER memory_effect_dispatch_cursor_guard
BEFORE UPDATE ON memory_effect_dispatch_cursor
WHEN NEW.singleton_id<>1
  OR NEW.accepted_through_sequence<OLD.accepted_through_sequence
  OR (OLD.active_lane_id IS NULL AND NEW.active_lane_id IS NOT NULL
      AND NEW.fence<>OLD.fence+1)
  OR (OLD.active_lane_id IS NOT NULL AND NEW.active_lane_id IS NOT NULL
      AND (OLD.active_lane_id<>NEW.active_lane_id OR OLD.active_request_digest<>NEW.active_request_digest))
  OR (OLD.active_lane_id IS NOT NULL AND NEW.active_lane_id IS NULL
      AND NEW.accepted_through_sequence<OLD.active_sequence)
BEGIN
  SELECT RAISE(ABORT,'memory destructive dispatch cursor invalid');
END;

CREATE TRIGGER memory_lifecycle_barrier_immutable_update
BEFORE UPDATE ON memory_lifecycle_barrier_events
BEGIN
  SELECT RAISE(ABORT,'immutable memory lifecycle barrier');
END;
CREATE TRIGGER memory_lifecycle_barrier_immutable_delete
BEFORE DELETE ON memory_lifecycle_barrier_events
BEGIN
  SELECT RAISE(ABORT,'immutable memory lifecycle barrier');
END;
