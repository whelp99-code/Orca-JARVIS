-- Durable record of a local retention rebuild.
--
-- The destination is claimed exclusively on disk, which stops one run from destroying another
-- run's file but leaves a process that dies mid-build with an unexplained partial file that every
-- later attempt refuses. This row is what a later run reads to tell its own abandoned work from a
-- file it cannot account for: the operation names the source it selected from, the generation it
-- would have produced, the digest of that selection, and the exact candidate path it claimed.
-- Ownership is the identity the destination claim created, recorded here: device, inode and birth
-- time. A file put at that path by anything else has a different identity, and unlike a marker
-- written beside the file none of these can be forged by whoever writes there next - a freed inode
-- number can be handed out again, but the birth time of the file that receives it cannot be set
-- from user space. Recovery removes a candidate only when the file still carries this identity;
-- anything else is preserved, never deleted on the strength of its name.
--
-- An applied row is written into the candidate before the rename, because the rename destroys the
-- database holding the 'verified' row: a record written afterwards would be missing for exactly
-- the window a crash is most likely to fall in. The rename keeps the inode, so result_device and
-- result_inode recorded there are the identity the live database actually has.
--
-- Identity is immutable and the stage only moves forward: preparing to verified or abandoned, and
-- verified to applied or abandoned. Rows are never deleted, so the lineage of every attempt stays
-- readable after recovery.
CREATE TABLE local_retention_operations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  owner_token TEXT NOT NULL CHECK(length(owner_token) BETWEEN 1 AND 128),
  source_device TEXT NOT NULL,
  source_inode TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>=1),
  result_generation INTEGER NOT NULL,
  selection_digest TEXT NOT NULL CHECK(selection_digest LIKE 'sha256:%'),
  candidate_path TEXT NOT NULL CHECK(length(candidate_path) BETWEEN 1 AND 512),
  claim_device TEXT NOT NULL CHECK(length(claim_device) BETWEEN 1 AND 40),
  claim_inode TEXT NOT NULL CHECK(length(claim_inode) BETWEEN 1 AND 40),
  claim_birthtime TEXT NOT NULL CHECK(length(claim_birthtime) BETWEEN 1 AND 40),
  state TEXT NOT NULL CHECK(state IN ('preparing','verified','applied','abandoned')),
  result_device TEXT CHECK(result_device IS NULL OR length(result_device) BETWEEN 1 AND 40),
  result_inode TEXT CHECK(result_inode IS NULL OR length(result_inode) BETWEEN 1 AND 40),
  failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(result_generation=source_generation+1),
  CHECK(julianday(updated_at)>=julianday(created_at)),
  CHECK((state='abandoned')=(failure_code IS NOT NULL)),
  CHECK((state='applied')=(result_device IS NOT NULL AND result_inode IS NOT NULL))
);
CREATE INDEX local_retention_operations_state
  ON local_retention_operations(state,created_at,operation_id);

CREATE TRIGGER local_retention_operations_identity_immutable BEFORE UPDATE OF
  operation_id,owner_token,source_device,source_inode,source_generation,result_generation,
  selection_digest,candidate_path,claim_device,claim_inode,claim_birthtime,created_at
  ON local_retention_operations
BEGIN SELECT RAISE(ABORT,'immutable retention operation identity'); END;

CREATE TRIGGER local_retention_operations_state_forward BEFORE UPDATE OF state
  ON local_retention_operations
WHEN NOT (OLD.state='preparing' AND NEW.state IN ('verified','abandoned'))
 AND NOT (OLD.state='verified' AND NEW.state IN ('applied','abandoned'))
BEGIN SELECT RAISE(ABORT,'invalid retention operation transition'); END;

CREATE TRIGGER local_retention_operations_insert_stage BEFORE INSERT
  ON local_retention_operations
WHEN NEW.state NOT IN ('preparing','applied')
BEGIN SELECT RAISE(ABORT,'retention operation enters as an attempt or an applied record'); END;

CREATE TRIGGER local_retention_operations_immutable_delete BEFORE DELETE
  ON local_retention_operations
BEGIN SELECT RAISE(ABORT,'immutable retention operation'); END;
