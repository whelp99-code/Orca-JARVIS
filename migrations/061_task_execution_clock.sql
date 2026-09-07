-- Persist the provider operation's boot/time-namespace deadline for later verifier processes.
-- Historical attempts retain NULL clocks and cannot acquire a fresh execution budget retroactively.
ALTER TABLE control_effect_attempts ADD COLUMN task_clock_id TEXT;
ALTER TABLE control_effect_attempts ADD COLUMN task_deadline_uptime_ms INTEGER;

CREATE TRIGGER control_effect_task_clock_insert BEFORE INSERT ON control_effect_attempts
WHEN NEW.task_clock_id IS NOT NULL OR NEW.task_deadline_uptime_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'task clock binds at invocation'); END;
CREATE TRIGGER control_effect_task_clock_update
BEFORE UPDATE OF task_clock_id,task_deadline_uptime_ms ON control_effect_attempts
WHEN OLD.task_run_id IS NULL OR OLD.state!='prepared' OR NEW.state!='invoking'
  OR OLD.task_clock_id IS NOT NULL OR OLD.task_deadline_uptime_ms IS NOT NULL
  OR NEW.task_clock_id IS NULL OR length(NEW.task_clock_id)>128
  OR typeof(NEW.task_deadline_uptime_ms)!='integer' OR NEW.task_deadline_uptime_ms<=0
BEGIN SELECT RAISE(ABORT,'immutable task invocation clock'); END;
CREATE TRIGGER control_effect_task_invocation_clock BEFORE UPDATE OF state ON control_effect_attempts
WHEN NEW.task_run_id IS NOT NULL AND NEW.state='invoking'
  AND (NEW.task_clock_id IS NULL OR typeof(NEW.task_deadline_uptime_ms)!='integer' OR NEW.task_deadline_uptime_ms<=0)
BEGIN SELECT RAISE(ABORT,'task invocation clock required'); END;
