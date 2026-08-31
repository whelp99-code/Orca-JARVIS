-- Task 30 JARVIS managed-surface purge, compaction, and restore high-water receipts.
CREATE TABLE memory_purge_jobs (
  purge_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK(lane IN ('correction','deletion')),
  lane_id TEXT NOT NULL UNIQUE,
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL REFERENCES memory_tombstone_chain(sequence),
  tombstone_set_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','compacting','verifying','completed','reconciling')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT,
  surface_manifest_digest TEXT UNIQUE,
  compaction_receipt_digest TEXT UNIQUE,
  scan_errors INTEGER,
  plaintext_matches INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state<>'completed' OR (surface_manifest_digest IS NOT NULL AND compaction_receipt_digest IS NOT NULL AND scan_errors=0 AND plaintext_matches=0))
);
CREATE INDEX memory_purge_state ON memory_purge_jobs(state,updated_at,purge_id);

CREATE TABLE memory_surface_manifests (
  manifest_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL UNIQUE,
  purge_id TEXT NOT NULL UNIQUE REFERENCES memory_purge_jobs(purge_id),
  owner TEXT NOT NULL CHECK(owner='jarvis'),
  tombstone_sequence INTEGER NOT NULL,
  tombstone_set_root TEXT NOT NULL,
  surface_count INTEGER NOT NULL CHECK(surface_count>=1),
  file_count INTEGER NOT NULL CHECK(file_count>=0),
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  object_count INTEGER NOT NULL CHECK(object_count>=0),
  fd_count INTEGER NOT NULL CHECK(fd_count>=0),
  match_count INTEGER NOT NULL CHECK(match_count=0),
  error_count INTEGER NOT NULL CHECK(error_count=0),
  created_at TEXT NOT NULL
);
CREATE TABLE memory_surface_entries (
  manifest_id TEXT NOT NULL REFERENCES memory_surface_manifests(manifest_id),
  surface_id TEXT NOT NULL,
  surface_kind TEXT NOT NULL CHECK(surface_kind IN ('authority','projection','state','backup','spool','wal','shm','journal','fd','restore')),
  manifest_digest TEXT NOT NULL,
  readable INTEGER NOT NULL CHECK(readable IN (0,1)),
  file_count INTEGER NOT NULL CHECK(file_count>=0),
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  object_count INTEGER NOT NULL CHECK(object_count>=0),
  fd_count INTEGER NOT NULL CHECK(fd_count>=0),
  match_count INTEGER NOT NULL CHECK(match_count=0),
  error_count INTEGER NOT NULL CHECK(error_count=0),
  scan_digest TEXT NOT NULL,
  PRIMARY KEY(manifest_id,surface_id)
);
CREATE TABLE memory_compaction_receipts (
  receipt_id TEXT PRIMARY KEY,
  receipt_digest TEXT NOT NULL UNIQUE,
  purge_id TEXT NOT NULL UNIQUE REFERENCES memory_purge_jobs(purge_id),
  source_database_digest TEXT NOT NULL,
  result_database_digest TEXT NOT NULL,
  surface_manifest_digest TEXT NOT NULL,
  old_database_disposed INTEGER NOT NULL CHECK(old_database_disposed=1),
  wal_disposed INTEGER NOT NULL CHECK(wal_disposed=1),
  shm_disposed INTEGER NOT NULL CHECK(shm_disposed=1),
  journal_disposed INTEGER NOT NULL CHECK(journal_disposed=1),
  backup_disposal_digest TEXT NOT NULL,
  reader_drain_digest TEXT NOT NULL,
  compacted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_spool_cleanup_receipts (
  cleanup_id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL UNIQUE,
  spool_digest TEXT NOT NULL UNIQUE,
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted','status_reconciled','expired','terminal_failure')),
  removed INTEGER NOT NULL CHECK(removed=1),
  parent_fsynced INTEGER NOT NULL CHECK(parent_fsynced=1),
  plaintext_matches INTEGER NOT NULL CHECK(plaintext_matches=0),
  removed_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_projection_suppression_receipts (
  receipt_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE REFERENCES memory_tombstone_chain(sequence),
  projection_count INTEGER NOT NULL CHECK(projection_count>=1),
  suppressed_row_count INTEGER NOT NULL CHECK(suppressed_row_count>=0),
  projection_manifest_digest TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE
);
CREATE TABLE memory_restore_high_water_receipts (
  receipt_id TEXT PRIMARY KEY,
  restore_id TEXT NOT NULL UNIQUE,
  source_database_digest TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=0),
  source_set_root TEXT NOT NULL,
  current_sequence INTEGER NOT NULL CHECK(current_sequence>=0),
  current_set_root TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('sanitized','rejected_stale','rejected_conflict')),
  sanitized_database_digest TEXT,
  surface_manifest_digest TEXT,
  activated INTEGER NOT NULL CHECK(activated IN (0,1)),
  created_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  CHECK((disposition='sanitized' AND sanitized_database_digest IS NOT NULL AND surface_manifest_digest IS NOT NULL) OR (disposition<>'sanitized' AND activated=0))
);
CREATE TABLE memory_managed_backups (
  backup_id TEXT PRIMARY KEY,
  backup_digest TEXT NOT NULL UNIQUE,
  tombstone_sequence INTEGER NOT NULL,
  tombstone_set_root TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('sealed','disposed')),
  created_at TEXT NOT NULL,
  disposed_at TEXT,
  disposal_digest TEXT UNIQUE,
  CHECK((state='sealed' AND disposed_at IS NULL AND disposal_digest IS NULL) OR (state='disposed' AND disposed_at IS NOT NULL AND disposal_digest IS NOT NULL))
);

CREATE TRIGGER memory_purge_initial BEFORE INSERT ON memory_purge_jobs WHEN NEW.state<>'pending' OR NEW.lease_fence<>0 BEGIN SELECT RAISE(ABORT,'memory purge must start pending'); END;
CREATE TRIGGER memory_purge_identity BEFORE UPDATE OF purge_id,lane,lane_id,target_manifest_digest,scope_digest,tombstone_sequence,tombstone_set_root,created_at ON memory_purge_jobs BEGIN SELECT RAISE(ABORT,'immutable memory purge identity'); END;
CREATE TRIGGER memory_purge_transition BEFORE UPDATE OF state ON memory_purge_jobs WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('pending:compacting','compacting:verifying','compacting:reconciling','verifying:completed','verifying:reconciling','reconciling:compacting','reconciling:verifying') BEGIN SELECT RAISE(ABORT,'memory purge transition invalid'); END;
CREATE TRIGGER memory_purge_complete_guard BEFORE UPDATE OF state ON memory_purge_jobs WHEN NEW.state='completed' AND NOT EXISTS (SELECT 1 FROM memory_surface_manifests m JOIN memory_compaction_receipts r ON r.purge_id=m.purge_id WHERE m.purge_id=OLD.purge_id AND m.manifest_digest=NEW.surface_manifest_digest AND r.receipt_digest=NEW.compaction_receipt_digest AND m.match_count=0 AND m.error_count=0) BEGIN SELECT RAISE(ABORT,'memory purge proof required'); END;
CREATE TRIGGER memory_surface_manifest_immutable_update BEFORE UPDATE ON memory_surface_manifests BEGIN SELECT RAISE(ABORT,'immutable memory surface manifest'); END;
CREATE TRIGGER memory_surface_manifest_immutable_delete BEFORE DELETE ON memory_surface_manifests BEGIN SELECT RAISE(ABORT,'immutable memory surface manifest'); END;
CREATE TRIGGER memory_surface_entry_immutable_update BEFORE UPDATE ON memory_surface_entries BEGIN SELECT RAISE(ABORT,'immutable memory surface entry'); END;
CREATE TRIGGER memory_surface_entry_immutable_delete BEFORE DELETE ON memory_surface_entries BEGIN SELECT RAISE(ABORT,'immutable memory surface entry'); END;
CREATE TRIGGER memory_compaction_receipt_immutable_update BEFORE UPDATE ON memory_compaction_receipts BEGIN SELECT RAISE(ABORT,'immutable memory compaction receipt'); END;
CREATE TRIGGER memory_compaction_receipt_immutable_delete BEFORE DELETE ON memory_compaction_receipts BEGIN SELECT RAISE(ABORT,'immutable memory compaction receipt'); END;
CREATE TRIGGER memory_spool_cleanup_immutable_update BEFORE UPDATE ON memory_spool_cleanup_receipts BEGIN SELECT RAISE(ABORT,'immutable memory spool cleanup'); END;
CREATE TRIGGER memory_spool_cleanup_immutable_delete BEFORE DELETE ON memory_spool_cleanup_receipts BEGIN SELECT RAISE(ABORT,'immutable memory spool cleanup'); END;
CREATE TRIGGER memory_projection_suppression_immutable_update BEFORE UPDATE ON memory_projection_suppression_receipts BEGIN SELECT RAISE(ABORT,'immutable memory projection suppression'); END;
CREATE TRIGGER memory_projection_suppression_immutable_delete BEFORE DELETE ON memory_projection_suppression_receipts BEGIN SELECT RAISE(ABORT,'immutable memory projection suppression'); END;
CREATE TRIGGER memory_restore_receipt_immutable_update BEFORE UPDATE ON memory_restore_high_water_receipts BEGIN SELECT RAISE(ABORT,'immutable memory restore receipt'); END;
CREATE TRIGGER memory_restore_receipt_immutable_delete BEFORE DELETE ON memory_restore_high_water_receipts BEGIN SELECT RAISE(ABORT,'immutable memory restore receipt'); END;
CREATE TRIGGER memory_backup_identity BEFORE UPDATE OF backup_id,backup_digest,tombstone_sequence,tombstone_set_root,target_manifest_digest,created_at ON memory_managed_backups BEGIN SELECT RAISE(ABORT,'immutable memory backup identity'); END;
