// Runtime guards close migration-033's intentional store-level fence seam without
// altering the frozen migration history. They are connection-local and apply only
// while the Daily Control Loop store owns the lifecycle.
export const DAILY_LOOP_STORE_GUARDS_SQL = `
  CREATE TEMP TRIGGER IF NOT EXISTS daily_loop_store_checkpoint_fence
  BEFORE INSERT ON main.daily_loop_checkpoints
  WHEN NOT EXISTS (
    SELECT 1 FROM main.daily_loop_runs r
    WHERE r.run_id=NEW.run_id AND r.lease_owner IS NOT NULL AND r.lease_fence=NEW.lease_fence
      AND r.state IN ('claimed','running','verifying')
      AND julianday(NEW.created_at)<julianday(r.lease_expires_at)
      AND julianday(NEW.created_at)<julianday(r.expires_at)
  )
  BEGIN SELECT RAISE(ABORT,'daily loop stale checkpoint fence'); END;
  CREATE TEMP TRIGGER IF NOT EXISTS daily_loop_store_checkpoint_chain
  BEFORE INSERT ON main.daily_loop_checkpoints
  WHEN NEW.sequence<>COALESCE((SELECT MAX(c.sequence)+1 FROM main.daily_loop_checkpoints c WHERE c.run_id=NEW.run_id),1)
    OR NEW.previous_digest IS NOT (
      SELECT c.checkpoint_digest FROM main.daily_loop_checkpoints c
      WHERE c.run_id=NEW.run_id ORDER BY c.sequence DESC LIMIT 1
    )
  BEGIN SELECT RAISE(ABORT,'daily loop checkpoint chain invalid'); END;
  CREATE TEMP TRIGGER IF NOT EXISTS daily_loop_store_step_fence
  BEFORE UPDATE OF state ON main.daily_loop_steps
  WHEN NOT EXISTS (
    SELECT 1 FROM main.daily_loop_runs r WHERE r.run_id=NEW.run_id AND r.lease_owner IS NOT NULL
      AND r.state IN ('claimed','running','verifying')
      AND julianday(NEW.updated_at)<julianday(r.lease_expires_at)
      AND julianday(NEW.updated_at)<julianday(r.expires_at)
  )
  BEGIN SELECT RAISE(ABORT,'daily loop stale step lease'); END;
`;
