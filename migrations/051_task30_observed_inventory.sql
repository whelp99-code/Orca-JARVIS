-- Task 30 content-free forbidden byte identities and restart-safe observed inventory.
ALTER TABLE memory_compaction_inputs ADD COLUMN provider_inventory_json TEXT;

CREATE TABLE memory_forbidden_content_identities (
  purge_id TEXT NOT NULL REFERENCES memory_purge_jobs(purge_id),
  identity_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK(content_bytes>0),
  window_bytes INTEGER NOT NULL CHECK(window_bytes BETWEEN 1 AND 32),
  window_digest TEXT NOT NULL,
  rolling_hash_a INTEGER NOT NULL CHECK(rolling_hash_a BETWEEN 0 AND 4294967295),
  rolling_hash_b INTEGER NOT NULL CHECK(rolling_hash_b BETWEEN 0 AND 4294967295),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  PRIMARY KEY(purge_id,identity_digest),
  UNIQUE(purge_id,content_digest)
);

CREATE TRIGGER memory_forbidden_content_identity_immutable_update
BEFORE UPDATE ON memory_forbidden_content_identities
BEGIN
  SELECT RAISE(ABORT,'immutable memory forbidden content identity');
END;
CREATE TRIGGER memory_forbidden_content_identity_immutable_delete
BEFORE DELETE ON memory_forbidden_content_identities
BEGIN
  SELECT RAISE(ABORT,'immutable memory forbidden content identity');
END;
