-- The snapshot a retention operation copies from, identified the way its candidate already is.
--
-- The apply claims two paths: the candidate and, beside it, the snapshot it copies from. Only the
-- candidate's identity was recorded, so a process that died mid-copy left a snapshot that recovery
-- could not prove it owned. Deleting it by name would be deleting a file on the strength of its
-- name; leaving it blocked every retry, because the path is claimed exclusively.
--
-- Nullable because an operation recorded before this migration has no snapshot identity, and a
-- snapshot that was already released leaves nothing to identify.
ALTER TABLE local_retention_operations ADD COLUMN snapshot_device TEXT;
ALTER TABLE local_retention_operations ADD COLUMN snapshot_inode TEXT;
ALTER TABLE local_retention_operations ADD COLUMN snapshot_birthtime TEXT;

-- What the candidate looked like when it was proved correct.
--
-- Verification happens while the candidate is built; installation happens later. Between them the
-- file keeps its device, inode and birth time even if its rows are rewritten, so identity alone
-- cannot say the installed bytes are the verified bytes. Recorded at verification and re-checked
-- immediately before the applied record is written.
ALTER TABLE local_retention_operations ADD COLUMN verified_digest TEXT;

DROP TRIGGER local_retention_operations_identity_immutable;
CREATE TRIGGER local_retention_operations_identity_immutable BEFORE UPDATE OF
  operation_id,owner_token,source_device,source_inode,source_generation,result_generation,
  selection_digest,candidate_path,claim_device,claim_inode,claim_birthtime,
  snapshot_device,snapshot_inode,snapshot_birthtime,created_at
  ON local_retention_operations
BEGIN SELECT RAISE(ABORT,'immutable retention operation identity'); END;
