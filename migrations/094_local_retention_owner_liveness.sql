-- The start token of the process that owns a retention operation.
--
-- Recovery removes what an operation left behind, and it now runs before the schedule window so a
-- crash is not hidden until the next one. That makes it reachable while another process is still
-- building: the row says `preparing` either way. A pid alone cannot tell them apart because pids
-- are reused, so the process start time is recorded with it and recovery leaves an operation alone
-- while that exact process is still running.
--
-- Nullable because rows written before this migration have no token; those are treated as having
-- no live owner, which is what they were treated as already.
ALTER TABLE local_retention_operations ADD COLUMN owner_start_token TEXT;

DROP TRIGGER local_retention_operations_identity_immutable;
CREATE TRIGGER local_retention_operations_identity_immutable BEFORE UPDATE OF
  operation_id,owner_token,owner_start_token,source_device,source_inode,source_generation,
  result_generation,selection_digest,candidate_path,claim_device,claim_inode,claim_birthtime,
  snapshot_device,snapshot_inode,snapshot_birthtime,created_at
  ON local_retention_operations
BEGIN SELECT RAISE(ABORT,'immutable retention operation identity'); END;
