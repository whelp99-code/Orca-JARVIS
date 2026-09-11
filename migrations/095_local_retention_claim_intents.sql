-- What a retention run intends to claim, written before it claims it.
--
-- The operation record cannot be written first: it carries the claim's identity and the digest of
-- a selection that only exists after the snapshot is copied, and copying is the long part of the
-- window. A process that died in that window left a directory on disk with nothing in the database
-- to explain it, and recovery reads rows, so it could not see it.
--
-- This row is written before the directory exists and removed once the operation it belongs to is
-- finished or the directory is gone. It is bookkeeping, not authority: it says only that this
-- process was about to create that path, which is exactly what recovery needs to recognise its own
-- abandoned work without deleting a path on the strength of its name.
CREATE TABLE local_retention_claim_intents (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  owner_token TEXT NOT NULL CHECK(length(owner_token) BETWEEN 1 AND 128),
  owner_start_token TEXT,
  directory TEXT NOT NULL UNIQUE CHECK(length(directory) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX local_retention_claim_intents_created
  ON local_retention_claim_intents(created_at,operation_id);
