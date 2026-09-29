-- Provider-originated tombstones. Separate from memory_tombstone_chain: SB owner
-- effects use a subject digest that fails that table's hmac-sha256 CHECK, and
-- re-appending them would mint a different root. Rows are verified before insert.
CREATE TABLE provider_tombstone_replica_heads (
  provider_instance_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  set_root TEXT NOT NULL CHECK(set_root GLOB 'sha256:[0-9a-f]*' AND length(set_root)=71),
  signing_key_id TEXT NOT NULL,
  replica_digest TEXT NOT NULL CHECK(replica_digest GLOB 'sha256:[0-9a-f]*' AND length(replica_digest)=71),
  learned_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',learned_at)=learned_at)
);
CREATE TABLE provider_tombstone_replica_entries (
  provider_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  tombstone_id TEXT NOT NULL CHECK(tombstone_id GLOB 'memtomb:v1:[0-9a-f]*' AND length(tombstone_id)=75),
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget')),
  lane_id TEXT NOT NULL,
  target_manifest_digest TEXT NOT NULL CHECK(target_manifest_digest GLOB 'sha256:[0-9a-f]*' AND length(target_manifest_digest)=71),
  scope_digest TEXT NOT NULL CHECK(scope_digest GLOB 'sha256:[0-9a-f]*' AND length(scope_digest)=71),
  authority_receipt_digest TEXT NOT NULL CHECK(authority_receipt_digest GLOB 'sha256:[0-9a-f]*' AND length(authority_receipt_digest)=71),
  payload_digest TEXT NOT NULL CHECK(payload_digest GLOB 'sha256:[0-9a-f]*' AND length(payload_digest)=71),
  keyed_subject_digest TEXT NOT NULL CHECK(length(keyed_subject_digest) BETWEEN 16 AND 200),
  effective_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at),
  previous_root TEXT NOT NULL CHECK(previous_root GLOB 'sha256:[0-9a-f]*' AND length(previous_root)=71),
  set_root TEXT NOT NULL CHECK(set_root GLOB 'sha256:[0-9a-f]*' AND length(set_root)=71),
  PRIMARY KEY(provider_instance_id, sequence),
  UNIQUE(provider_instance_id, tombstone_id),
  UNIQUE(provider_instance_id, set_root)
);
CREATE TABLE provider_tombstone_replica_targets (
  provider_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  target_digest TEXT NOT NULL CHECK(target_digest GLOB 'sha256:[0-9a-f]*' AND length(target_digest)=71),
  source_identity_digest TEXT NOT NULL,
  content_identity_digest TEXT NOT NULL,
  citation_identity_digest TEXT NOT NULL,
  subject_identity_digest TEXT NOT NULL,
  page_content_digest TEXT NOT NULL CHECK(page_content_digest GLOB 'sha256:[0-9a-f]*' AND length(page_content_digest)=71),
  PRIMARY KEY(provider_instance_id, sequence, target_digest)
);
CREATE TRIGGER provider_tombstone_replica_heads_immutable_update BEFORE UPDATE ON provider_tombstone_replica_heads
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
CREATE TRIGGER provider_tombstone_replica_heads_immutable_delete BEFORE DELETE ON provider_tombstone_replica_heads
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
CREATE TRIGGER provider_tombstone_replica_entries_immutable_update BEFORE UPDATE ON provider_tombstone_replica_entries
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
CREATE TRIGGER provider_tombstone_replica_entries_immutable_delete BEFORE DELETE ON provider_tombstone_replica_entries
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
CREATE TRIGGER provider_tombstone_replica_targets_immutable_update BEFORE UPDATE ON provider_tombstone_replica_targets
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
CREATE TRIGGER provider_tombstone_replica_targets_immutable_delete BEFORE DELETE ON provider_tombstone_replica_targets
BEGIN SELECT RAISE(ABORT, 'immutable provider tombstone replica'); END;
