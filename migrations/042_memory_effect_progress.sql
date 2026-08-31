-- Task 30 append-only provider progress and recovery observations.
CREATE TABLE memory_effect_progress (
  progress_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES memory_effect_requests(request_id),
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  phase TEXT NOT NULL CHECK(phase IN (
    'accepted','claimed','staging','sealed','switch_intent','activated','disposing','proved','completed','failed','uncertain'
  )),
  generation_id TEXT,
  generation_manifest_digest TEXT,
  tombstone_sequence INTEGER CHECK(tombstone_sequence IS NULL OR tombstone_sequence>=0),
  tombstone_set_root TEXT,
  observation_json TEXT NOT NULL,
  observation_digest TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(request_id,sequence)
);
CREATE INDEX memory_effect_progress_request ON memory_effect_progress(request_id,sequence,progress_id);

CREATE TRIGGER memory_effect_progress_order BEFORE INSERT ON memory_effect_progress
WHEN NEW.sequence<>COALESCE((SELECT MAX(sequence)+1 FROM memory_effect_progress WHERE request_id=NEW.request_id),1)
BEGIN SELECT RAISE(ABORT,'memory effect progress sequence invalid'); END;
CREATE TRIGGER memory_effect_progress_immutable_update BEFORE UPDATE ON memory_effect_progress
  BEGIN SELECT RAISE(ABORT,'immutable memory effect progress'); END;
CREATE TRIGGER memory_effect_progress_immutable_delete BEFORE DELETE ON memory_effect_progress
  BEGIN SELECT RAISE(ABORT,'immutable memory effect progress'); END;
