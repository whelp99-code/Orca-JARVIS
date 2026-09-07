-- Bind generic task operations to the existing external-effect ledger, across request IDs.
ALTER TABLE control_effect_attempts ADD COLUMN task_run_id TEXT REFERENCES workflow_runs(run_id);
ALTER TABLE control_effect_attempts ADD COLUMN task_plan_digest TEXT;
CREATE UNIQUE INDEX control_effect_task_operation
  ON control_effect_attempts(task_run_id,task_plan_digest) WHERE task_run_id IS NOT NULL;

-- REPLACE can bypass DELETE triggers when recursive_triggers is off. Reject before SQLite deletes any conflicting row.
CREATE TRIGGER control_effect_task_replace_guard BEFORE INSERT ON control_effect_attempts
WHEN EXISTS(SELECT 1 FROM control_effect_attempts a
  WHERE (a.task_run_id IS NOT NULL OR NEW.task_run_id IS NOT NULL OR NEW.effect_type='task.execute')
    AND (a.rowid=NEW.rowid OR a.attempt_id=NEW.attempt_id OR a.request_id=NEW.request_id OR a.idempotency_key=NEW.idempotency_key
      OR (a.task_run_id=NEW.task_run_id AND a.task_plan_digest=NEW.task_plan_digest)))
BEGIN SELECT RAISE(ABORT,'task execution operation already exists'); END;
CREATE TRIGGER control_effect_task_rowid_guard BEFORE UPDATE ON control_effect_attempts
WHEN NEW.rowid!=OLD.rowid AND (OLD.task_run_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM control_effect_attempts WHERE rowid=NEW.rowid AND task_run_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable task execution rowid'); END;

CREATE TRIGGER control_effect_task_binding_insert BEFORE INSERT ON control_effect_attempts
WHEN NEW.effect_type='task.execute' OR NEW.task_run_id IS NOT NULL OR NEW.task_plan_digest IS NOT NULL
  OR EXISTS(SELECT 1 FROM control_command_requests WHERE request_id=NEW.request_id AND action='task.execute')
BEGIN
  SELECT CASE WHEN NEW.effect_type!='task.execute' OR NEW.state!='prepared'
    OR NEW.task_run_id IS NULL OR NEW.task_plan_digest IS NULL
    OR NOT EXISTS(
      SELECT 1 FROM control_command_requests r
      JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
      JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
      WHERE r.request_id=NEW.request_id AND r.action='task.execute' AND r.action_level>=3 AND r.state='claimed'
        AND x.receipt_id=NEW.receipt_id AND r.lease_fence=NEW.lease_fence
        AND a.decision='approve' AND a.command_digest=r.command_digest
        AND json_extract(r.args_json,'$.plan.run_id')=NEW.task_run_id
        AND json_extract(r.args_json,'$.execution_plan_digest')=NEW.task_plan_digest
    ) THEN RAISE(ABORT,'task execution binding required') END;
END;
CREATE TRIGGER control_effect_task_binding_immutable
  BEFORE UPDATE OF task_run_id,task_plan_digest ON control_effect_attempts
BEGIN SELECT RAISE(ABORT,'immutable task execution binding'); END;

-- Uncertain attempts require future reconciliation; this migration deliberately provides no replay transition.
CREATE TRIGGER control_effect_task_state_guard BEFORE UPDATE OF state ON control_effect_attempts
WHEN OLD.task_run_id IS NOT NULL AND NOT (
  (OLD.state='prepared' AND NEW.state IN ('invoking','uncertain')) OR
  (OLD.state='invoking' AND NEW.state IN ('confirmed','uncertain'))
)
BEGIN SELECT RAISE(ABORT,'invalid task execution transition'); END;
