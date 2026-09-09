-- Minimal local admission evidence; no FK to observations, so source erasure is not blocked.
-- Readers must revalidate every referenced observation and its current suppression state.
CREATE TABLE observation_refresh_receipts (
  refresh_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL UNIQUE,
  scope_digest TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=131072),
  completed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',completed_at)=completed_at),
  CHECK(length(refresh_id)=79 AND substr(refresh_id,1,15)='refresh:sha256:'),
  CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:'),
  CHECK(length(scope_digest)=71 AND substr(scope_digest,1,7)='sha256:'),
  CHECK(length(receipt_digest)=71 AND substr(receipt_digest,1,7)='sha256:')
);
CREATE INDEX observation_refresh_scope_time ON observation_refresh_receipts(scope_digest,completed_at DESC,refresh_id);
CREATE TRIGGER observation_refresh_immutable_update BEFORE UPDATE ON observation_refresh_receipts
BEGIN SELECT RAISE(ABORT,'OBSERVATION_REFRESH_IMMUTABLE'); END;
CREATE TRIGGER observation_refresh_immutable_delete BEFORE DELETE ON observation_refresh_receipts
BEGIN SELECT RAISE(ABORT,'OBSERVATION_REFRESH_IMMUTABLE'); END;
