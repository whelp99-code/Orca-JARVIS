-- Task 30 normalized projection lineage, fail-closed quarantine, and immediate invalidation.
CREATE TABLE memory_projection_authority (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  rebuild_state TEXT NOT NULL CHECK(rebuild_state IN ('pending','rebuilding','ready','failed')),
  catalog_digest TEXT,
  rebuilt_at TEXT,
  failure_code TEXT
);
INSERT INTO memory_projection_authority(
  singleton_id,schema_version,rebuild_state,catalog_digest,rebuilt_at,failure_code
) VALUES(1,1,'ready',NULL,'1970-01-01T00:00:00.000Z',NULL);

CREATE TABLE memory_projection_dependencies (
  projection_kind TEXT NOT NULL CHECK(projection_kind IN (
    'context','recommendation','recommendation_action','daily_run','daily_step',
    'morning_brief','evening_closeout','notification_intent','notification_delivery',
    'task_timeline','dashboard_projection','state_generation','control_payload','observation'
  )),
  projection_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  target_digest TEXT,
  keyed_subject_digest TEXT,
  source_identity_digest TEXT,
  content_identity_digest TEXT,
  citation_identity_digest TEXT,
  source_context_id TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  PRIMARY KEY(projection_kind,projection_id,component_id,target_digest),
  CHECK(target_digest IS NOT NULL OR keyed_subject_digest IS NOT NULL
    OR source_identity_digest IS NOT NULL OR content_identity_digest IS NOT NULL
    OR citation_identity_digest IS NOT NULL)
);
CREATE INDEX memory_projection_dependency_target
  ON memory_projection_dependencies(target_digest);
CREATE INDEX memory_projection_dependency_source
  ON memory_projection_dependencies(source_identity_digest,content_identity_digest,citation_identity_digest);

INSERT OR IGNORE INTO memory_projection_dependencies(
  projection_kind,projection_id,component_id,target_digest,keyed_subject_digest,
  source_identity_digest,content_identity_digest,citation_identity_digest,
  source_context_id,created_at
)
SELECT 'context',m.context_id,m.context_id,t.target_digest,t.keyed_subject_digest,
  t.source_identity_digest,t.content_identity_digest,t.citation_identity_digest,
  m.context_id,m.observed_at
FROM personal_context_memory_evidence m JOIN memory_resolved_target_metadata t
  ON m.memory_ref=t.target_id OR m.memory_ref=t.target_digest;

CREATE TABLE memory_projection_suppressions (
  sequence INTEGER NOT NULL REFERENCES memory_tombstone_chain(sequence),
  projection_kind TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  suppression_id TEXT NOT NULL REFERENCES memory_suppressions(suppression_id),
  effective_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at),
  PRIMARY KEY(sequence,projection_kind,projection_id,component_id,suppression_id)
);
CREATE INDEX memory_projection_suppression_lookup
  ON memory_projection_suppressions(projection_kind,projection_id,component_id);

CREATE TABLE memory_projection_quarantine (
  projection_kind TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('lineage_unresolved','lineage_ambiguous','lineage_invalid')),
  detected_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',detected_at)=detected_at),
  source_digest TEXT,
  PRIMARY KEY(projection_kind,projection_id,component_id)
);

CREATE TABLE memory_suppression_events (
  sequence INTEGER PRIMARY KEY REFERENCES memory_tombstone_chain(sequence),
  event_digest TEXT NOT NULL UNIQUE,
  projection_count INTEGER NOT NULL CHECK(projection_count>=0),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  published_at TEXT CHECK(published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',published_at)=published_at)
);

CREATE TRIGGER memory_projection_dependency_immutable_update
BEFORE UPDATE ON memory_projection_dependencies
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection dependency');
END;
CREATE TRIGGER memory_projection_dependency_immutable_delete
BEFORE DELETE ON memory_projection_dependencies
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection dependency');
END;
CREATE TRIGGER memory_projection_link_suppression_immutable_update
BEFORE UPDATE ON memory_projection_suppressions
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection suppression');
END;
CREATE TRIGGER memory_projection_link_suppression_immutable_delete
BEFORE DELETE ON memory_projection_suppressions
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection suppression');
END;
CREATE TRIGGER memory_projection_quarantine_immutable_update
BEFORE UPDATE ON memory_projection_quarantine
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection quarantine');
END;
CREATE TRIGGER memory_projection_quarantine_immutable_delete
BEFORE DELETE ON memory_projection_quarantine
BEGIN
  SELECT RAISE(ABORT,'immutable memory projection quarantine');
END;
CREATE TRIGGER memory_suppression_event_identity
BEFORE UPDATE OF sequence,event_digest,projection_count,created_at ON memory_suppression_events
BEGIN
  SELECT RAISE(ABORT,'immutable memory suppression event');
END;
CREATE TRIGGER memory_suppression_event_publish
BEFORE UPDATE OF published_at ON memory_suppression_events
WHEN OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
BEGIN
  SELECT RAISE(ABORT,'memory suppression event publish invalid');
END;
CREATE TRIGGER memory_suppression_event_immutable_delete
BEFORE DELETE ON memory_suppression_events
BEGIN
  SELECT RAISE(ABORT,'immutable memory suppression event');
END;
