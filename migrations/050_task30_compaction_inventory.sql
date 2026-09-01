-- Task 30 fresh-file authority generations, measured drain, and exact 70-row inventory.
CREATE TABLE memory_database_generations (
  generation INTEGER PRIMARY KEY CHECK(generation>=1),
  database_manifest_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','retired')),
  activated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',activated_at)=activated_at),
  retired_at TEXT CHECK(retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',retired_at)=retired_at)
);
INSERT INTO memory_database_generations(
  generation,database_manifest_digest,state,activated_at,retired_at
) VALUES(1,'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'active','1970-01-01T00:00:00.000Z',NULL);

CREATE TABLE memory_compaction_runs (
  purge_id TEXT PRIMARY KEY REFERENCES memory_purge_jobs(purge_id),
  source_generation INTEGER NOT NULL,
  result_generation INTEGER NOT NULL,
  source_device TEXT NOT NULL,
  source_inode TEXT NOT NULL,
  result_device TEXT,
  result_inode TEXT,
  logical_source_digest TEXT NOT NULL,
  logical_result_digest TEXT,
  integrity_check TEXT,
  foreign_key_error_count INTEGER,
  quiesce_receipt_digest TEXT,
  reader_drain_digest TEXT,
  swap_receipt_digest TEXT,
  physical_scan_digest TEXT,
  state TEXT NOT NULL CHECK(state IN (
    'pending','building','verified','quiescing','swapped','draining','completed','reconciling'
  )),
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  completed_at TEXT CHECK(completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',completed_at)=completed_at),
  CHECK(result_generation=source_generation+1)
);

CREATE TABLE memory_compaction_inputs (
  purge_id TEXT PRIMARY KEY REFERENCES memory_compaction_runs(purge_id),
  provider_manifest_digest TEXT NOT NULL,
  provider_catalog_rows INTEGER NOT NULL CHECK(provider_catalog_rows=40),
  provider_signature_verified INTEGER NOT NULL CHECK(provider_signature_verified=1),
  reingress_guards_json TEXT NOT NULL,
  input_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TABLE memory_reader_drain_observations (
  purge_id TEXT NOT NULL REFERENCES memory_compaction_runs(purge_id),
  process_id INTEGER NOT NULL,
  process_start_token TEXT NOT NULL,
  database_device TEXT NOT NULL,
  database_inode TEXT NOT NULL,
  registered_leases INTEGER NOT NULL CHECK(registered_leases>=0),
  proc_fd_count INTEGER NOT NULL CHECK(proc_fd_count>=0),
  acknowledged_generation INTEGER NOT NULL CHECK(acknowledged_generation>=1),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  PRIMARY KEY(purge_id,process_id,process_start_token)
);

CREATE TABLE memory_surface_catalog_manifests (
  manifest_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL UNIQUE,
  purge_id TEXT NOT NULL REFERENCES memory_purge_jobs(purge_id),
  catalog_digest TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL REFERENCES memory_tombstone_chain(sequence),
  tombstone_set_root TEXT NOT NULL,
  expected_surface_count INTEGER NOT NULL CHECK(expected_surface_count=70),
  observed_surface_count INTEGER NOT NULL CHECK(observed_surface_count=70),
  omission_count INTEGER NOT NULL CHECK(omission_count=0),
  error_count INTEGER NOT NULL CHECK(error_count=0),
  match_count INTEGER NOT NULL CHECK(match_count=0),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TABLE memory_surface_catalog_entries (
  manifest_id TEXT NOT NULL REFERENCES memory_surface_catalog_manifests(manifest_id),
  catalog_key TEXT NOT NULL,
  owner TEXT NOT NULL CHECK(owner IN ('second_brain','exports','jarvis','reingress')),
  surface_id TEXT NOT NULL,
  scanner_kind TEXT NOT NULL CHECK(scanner_kind IN ('provider_manifest','filesystem','sqlite','proc_fd','guard')),
  required INTEGER NOT NULL CHECK(required=1),
  applicable INTEGER NOT NULL CHECK(applicable IN (0,1)),
  readable INTEGER NOT NULL CHECK(readable IN (0,1)),
  manifest_digest TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK(file_count>=0),
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  object_count INTEGER NOT NULL CHECK(object_count>=0),
  fd_count INTEGER NOT NULL CHECK(fd_count>=0),
  match_count INTEGER NOT NULL CHECK(match_count=0),
  error_count INTEGER NOT NULL CHECK(error_count=0),
  omission_count INTEGER NOT NULL CHECK(omission_count=0),
  scan_digest TEXT NOT NULL,
  PRIMARY KEY(manifest_id,catalog_key),
  UNIQUE(manifest_id,owner,surface_id)
);

CREATE TRIGGER memory_database_generation_single_active
BEFORE INSERT ON memory_database_generations
WHEN NEW.state='active' AND EXISTS (
  SELECT 1 FROM memory_database_generations WHERE state='active'
)
BEGIN
  SELECT RAISE(ABORT,'memory database generation already active');
END;
CREATE TRIGGER memory_database_generation_transition
BEFORE UPDATE OF state ON memory_database_generations
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state<>'active:retired'
BEGIN
  SELECT RAISE(ABORT,'memory database generation transition invalid');
END;
CREATE TRIGGER memory_surface_catalog_manifest_immutable_update
BEFORE UPDATE ON memory_surface_catalog_manifests
BEGIN
  SELECT RAISE(ABORT,'immutable memory surface catalog manifest');
END;
CREATE TRIGGER memory_surface_catalog_manifest_immutable_delete
BEFORE DELETE ON memory_surface_catalog_manifests
BEGIN
  SELECT RAISE(ABORT,'immutable memory surface catalog manifest');
END;
CREATE TRIGGER memory_surface_catalog_entry_immutable_update
BEFORE UPDATE ON memory_surface_catalog_entries
BEGIN
  SELECT RAISE(ABORT,'immutable memory surface catalog entry');
END;
CREATE TRIGGER memory_surface_catalog_entry_immutable_delete
BEFORE DELETE ON memory_surface_catalog_entries
BEGIN
  SELECT RAISE(ABORT,'immutable memory surface catalog entry');
END;
CREATE TRIGGER memory_compaction_input_immutable_update
BEFORE UPDATE ON memory_compaction_inputs
BEGIN
  SELECT RAISE(ABORT,'immutable memory compaction input');
END;
CREATE TRIGGER memory_compaction_input_immutable_delete
BEFORE DELETE ON memory_compaction_inputs
BEGIN
  SELECT RAISE(ABORT,'immutable memory compaction input');
END;
CREATE TRIGGER memory_reader_drain_immutable_update
BEFORE UPDATE ON memory_reader_drain_observations
BEGIN
  SELECT RAISE(ABORT,'immutable memory reader drain observation');
END;
CREATE TRIGGER memory_reader_drain_immutable_delete
BEFORE DELETE ON memory_reader_drain_observations
BEGIN
  SELECT RAISE(ABORT,'immutable memory reader drain observation');
END;
