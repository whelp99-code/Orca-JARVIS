CREATE TABLE memory_cancellation_material_checkpoints (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_cancellation_intents(correction_id),
  purge_id TEXT NOT NULL REFERENCES memory_purge_jobs(purge_id),
  spool_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK(content_bytes>0),
  identities_json TEXT NOT NULL CHECK(json_valid(identities_json)),
  identity_manifest_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER memory_cancellation_material_no_update BEFORE UPDATE ON memory_cancellation_material_checkpoints
BEGIN SELECT RAISE(ABORT,'immutable cancellation material'); END;
CREATE TRIGGER memory_cancellation_material_no_delete BEFORE DELETE ON memory_cancellation_material_checkpoints
BEGIN SELECT RAISE(ABORT,'immutable cancellation material'); END;
CREATE TRIGGER memory_cancellation_material_no_replace BEFORE INSERT ON memory_cancellation_material_checkpoints
WHEN EXISTS(SELECT 1 FROM memory_cancellation_material_checkpoints WHERE correction_id=NEW.correction_id)
BEGIN SELECT RAISE(ABORT,'immutable cancellation material'); END;
