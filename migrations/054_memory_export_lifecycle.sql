-- Task 32 signed metadata-only export lifecycle observations.
CREATE TABLE memory_export_lifecycle_observations (
  observation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','available','expired','invalidated')),
  manifest_digest TEXT NOT NULL,
  manifest_revision TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL CHECK(tombstone_sequence>=0),
  tombstone_set_root TEXT NOT NULL,
  status_digest TEXT NOT NULL UNIQUE,
  provider_signing_key_id TEXT NOT NULL,
  signature_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invalidated_at TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(request_id,status_digest),
  CHECK((state='invalidated')=(invalidated_at IS NOT NULL))
);
CREATE INDEX memory_export_lifecycle_request
  ON memory_export_lifecycle_observations(request_id,observed_at,observation_id);
CREATE TABLE memory_privacy_epoch_events (
  privacy_epoch INTEGER PRIMARY KEY CHECK(privacy_epoch>=1),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('suppression','membership_repair','session_rotation',
    'policy_change','generation_change')),
  resource_revision TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL
);
CREATE TRIGGER memory_export_lifecycle_transition BEFORE INSERT ON memory_export_lifecycle_observations
WHEN EXISTS (
  SELECT 1 FROM memory_export_lifecycle_observations prior
  WHERE prior.request_id=NEW.request_id
    AND ((prior.state IN ('expired','invalidated') AND NEW.state<>prior.state)
      OR (prior.state='available' AND NEW.state='pending'))
)
BEGIN SELECT RAISE(ABORT,'memory export lifecycle reversal'); END;
CREATE TRIGGER memory_export_lifecycle_immutable_update BEFORE UPDATE ON memory_export_lifecycle_observations
BEGIN SELECT RAISE(ABORT,'immutable memory export lifecycle observation'); END;
CREATE TRIGGER memory_export_lifecycle_immutable_delete BEFORE DELETE ON memory_export_lifecycle_observations
BEGIN SELECT RAISE(ABORT,'immutable memory export lifecycle observation'); END;
CREATE TRIGGER memory_privacy_epoch_immutable_update BEFORE UPDATE ON memory_privacy_epoch_events
BEGIN SELECT RAISE(ABORT,'immutable memory privacy epoch event'); END;
CREATE TRIGGER memory_privacy_epoch_immutable_delete BEFORE DELETE ON memory_privacy_epoch_events
BEGIN SELECT RAISE(ABORT,'immutable memory privacy epoch event'); END;
