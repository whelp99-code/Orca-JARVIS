-- Task 30 frozen target identities and monotone tombstone high-water observations.
CREATE TABLE memory_resolved_targets (
  target_id TEXT PRIMARY KEY CHECK(target_id GLOB 'sbtarget:v1:[0-9a-f]*' AND length(target_id)=76),
  target_digest TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_manifest_digest TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_blob_oid TEXT NOT NULL,
  page_content_digest TEXT NOT NULL,
  source_identity_full TEXT NOT NULL,
  content_identity_full TEXT NOT NULL,
  citation_identity_full TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','personal','sensitive','restricted')),
  source_owner_class TEXT NOT NULL CHECK(source_owner_class IN ('provider_owned','external_read_only')),
  source_owner_id_digest TEXT NOT NULL,
  target_json TEXT NOT NULL,
  resolved_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at)=resolved_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  CHECK(julianday(expires_at)>julianday(resolved_at))
);
CREATE INDEX memory_resolved_targets_page ON memory_resolved_targets(provider_instance_id,page_id,resolved_at,target_id);

CREATE TABLE memory_effect_request_targets (
  request_id TEXT NOT NULL REFERENCES memory_effect_requests(request_id),
  target_id TEXT NOT NULL REFERENCES memory_resolved_targets(target_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<64),
  PRIMARY KEY(request_id,target_id),
  UNIQUE(request_id,ordinal)
);

CREATE TABLE memory_tombstone_watermarks (
  provider_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  set_root TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES memory_effect_requests(request_id),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  PRIMARY KEY(provider_instance_id,sequence),
  UNIQUE(provider_instance_id,set_root)
);
CREATE INDEX memory_tombstone_latest ON memory_tombstone_watermarks(provider_instance_id,sequence DESC);

CREATE TRIGGER memory_tombstone_monotone BEFORE INSERT ON memory_tombstone_watermarks
WHEN NEW.sequence<=COALESCE((SELECT MAX(sequence) FROM memory_tombstone_watermarks WHERE provider_instance_id=NEW.provider_instance_id),-1)
BEGIN SELECT RAISE(ABORT,'memory tombstone watermark stale'); END;
CREATE TRIGGER memory_resolved_targets_immutable_update BEFORE UPDATE ON memory_resolved_targets
  BEGIN SELECT RAISE(ABORT,'immutable memory resolved target'); END;
CREATE TRIGGER memory_resolved_targets_immutable_delete BEFORE DELETE ON memory_resolved_targets
  BEGIN SELECT RAISE(ABORT,'immutable memory resolved target'); END;
CREATE TRIGGER memory_effect_request_targets_immutable_update BEFORE UPDATE ON memory_effect_request_targets
  BEGIN SELECT RAISE(ABORT,'immutable memory request target'); END;
CREATE TRIGGER memory_effect_request_targets_immutable_delete BEFORE DELETE ON memory_effect_request_targets
  BEGIN SELECT RAISE(ABORT,'immutable memory request target'); END;
CREATE TRIGGER memory_tombstone_watermarks_immutable_update BEFORE UPDATE ON memory_tombstone_watermarks
  BEGIN SELECT RAISE(ABORT,'immutable memory tombstone watermark'); END;
CREATE TRIGGER memory_tombstone_watermarks_immutable_delete BEFORE DELETE ON memory_tombstone_watermarks
  BEGIN SELECT RAISE(ABORT,'immutable memory tombstone watermark'); END;
