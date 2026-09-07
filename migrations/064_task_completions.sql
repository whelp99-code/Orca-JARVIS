CREATE TABLE task_completions (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES control_effect_attempts(attempt_id),
  publication_id TEXT NOT NULL UNIQUE REFERENCES task_git_publications(publication_id),
  completion_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=32768),
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER task_completion_replace_guard BEFORE INSERT ON task_completions
WHEN EXISTS(SELECT 1 FROM task_completions WHERE run_id=NEW.run_id OR request_id=NEW.request_id
  OR attempt_id=NEW.attempt_id OR publication_id=NEW.publication_id OR completion_id=NEW.completion_id)
BEGIN SELECT RAISE(ABORT,'immutable task completion'); END;
CREATE TRIGGER task_completion_update_guard BEFORE UPDATE ON task_completions
BEGIN SELECT RAISE(ABORT,'immutable task completion'); END;
CREATE TRIGGER task_completion_delete_guard BEFORE DELETE ON task_completions
BEGIN SELECT RAISE(ABORT,'immutable task completion'); END;
CREATE TRIGGER task_completion_insert_guard BEFORE INSERT ON task_completions
WHEN NOT EXISTS(
  SELECT 1 FROM task_git_publications p
  JOIN control_effect_attempts a ON a.attempt_id=p.attempt_id
  JOIN control_command_requests r ON r.request_id=a.request_id
  JOIN workflow_runs w ON w.run_id=a.task_run_id
  WHERE p.publication_id=NEW.publication_id AND p.state='published' AND p.attempt_id=NEW.attempt_id
    AND a.state='invoking' AND a.task_run_id=NEW.run_id AND r.request_id=NEW.request_id
    AND r.action='task.execute' AND r.state='claimed' AND r.lease_fence=a.lease_fence
    AND w.state IN ('running','waiting_approval')
    AND json_extract(NEW.payload_json,'$.schema_version')=1
    AND json_extract(NEW.payload_json,'$.state')='completed'
    AND json_extract(NEW.payload_json,'$.request_id')=NEW.request_id
    AND json_extract(NEW.payload_json,'$.run_id')=NEW.run_id
    AND json_extract(NEW.payload_json,'$.completion_id')=NEW.completion_id
    AND json_extract(NEW.payload_json,'$.publication_id')=NEW.publication_id
    AND json_extract(NEW.payload_json,'$.publication_digest')=p.binding_digest
    AND json_extract(NEW.payload_json,'$.command_digest')=r.command_digest
    AND json_extract(NEW.payload_json,'$.commit')=p.commit_oid
    AND json_extract(NEW.payload_json,'$.tree')=p.tree_oid
    AND json_extract(NEW.payload_json,'$.from_node')=w.current_node
    AND json_extract(NEW.payload_json,'$.prior_attempts')=w.attempts
    AND json_extract(NEW.payload_json,'$.completed_at')=NEW.created_at
)
BEGIN SELECT RAISE(ABORT,'task completion publication required'); END;
CREATE TRIGGER task_confirmed_completion_guard BEFORE UPDATE OF state ON control_effect_attempts
WHEN OLD.state='invoking' AND NEW.task_run_id IS NOT NULL AND NEW.state='confirmed' AND NOT EXISTS(
  SELECT 1 FROM task_completions c WHERE c.attempt_id=NEW.attempt_id AND c.request_id=NEW.request_id
    AND c.run_id=NEW.task_run_id AND c.payload_json=NEW.receipt_json AND c.payload_digest=NEW.receipt_digest)
BEGIN SELECT RAISE(ABORT,'task completion receipt required'); END;
CREATE TRIGGER task_command_initial_completion_guard BEFORE INSERT ON control_command_requests
WHEN NEW.action='task.execute' AND NEW.state='completed'
BEGIN SELECT RAISE(ABORT,'task completion receipt required'); END;
CREATE TRIGGER task_command_replace_completion_guard BEFORE INSERT ON control_command_requests
WHEN EXISTS(SELECT 1 FROM control_command_requests r
  WHERE (r.action='task.execute' OR NEW.action='task.execute')
    AND (r.rowid=NEW.rowid OR r.request_id=NEW.request_id OR r.nonce=NEW.nonce OR r.command_digest=NEW.command_digest))
BEGIN SELECT RAISE(ABORT,'immutable task execution request'); END;
CREATE TRIGGER task_workflow_replace_completion_guard BEFORE INSERT ON workflow_runs
WHEN EXISTS(SELECT 1 FROM workflow_runs w WHERE (w.rowid=NEW.rowid OR w.run_id=NEW.run_id)
  AND (json_type(w.input_json,'$.task_spec') IS NOT NULL OR json_type(NEW.input_json,'$.task_spec') IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable task workflow'); END;
CREATE TRIGGER task_command_rowid_completion_guard BEFORE UPDATE ON control_command_requests
WHEN NEW.rowid!=OLD.rowid AND (OLD.action='task.execute'
  OR EXISTS(SELECT 1 FROM control_command_requests WHERE rowid=NEW.rowid AND action='task.execute'))
BEGIN SELECT RAISE(ABORT,'immutable task execution rowid'); END;
CREATE TRIGGER task_workflow_rowid_completion_guard BEFORE UPDATE ON workflow_runs
WHEN NEW.rowid!=OLD.rowid AND (json_type(OLD.input_json,'$.task_spec') IS NOT NULL
  OR EXISTS(SELECT 1 FROM workflow_runs WHERE rowid=NEW.rowid AND json_type(input_json,'$.task_spec') IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable task workflow rowid'); END;
CREATE TRIGGER task_command_completion_guard BEFORE UPDATE OF state ON control_command_requests
WHEN NEW.action='task.execute' AND NEW.state='completed' AND NOT EXISTS(
  SELECT 1 FROM task_completions c JOIN control_effect_attempts a ON a.attempt_id=c.attempt_id
  JOIN control_command_effects e ON e.request_id=c.request_id AND e.effect_type='task.execution.completed'
  WHERE c.request_id=NEW.request_id AND a.lease_fence=NEW.lease_fence AND a.state='confirmed'
    AND e.payload_json=c.payload_json AND e.payload_digest=c.payload_digest AND c.created_at=NEW.completed_at)
BEGIN SELECT RAISE(ABORT,'task completion receipt required'); END;
CREATE TRIGGER task_workflow_initial_completion_guard BEFORE INSERT ON workflow_runs
WHEN NEW.state='completed' AND json_type(NEW.input_json,'$.task_spec') IS NOT NULL
BEGIN SELECT RAISE(ABORT,'task completion receipt required'); END;
CREATE TRIGGER task_workflow_completion_guard BEFORE UPDATE OF state ON workflow_runs
WHEN NEW.state='completed' AND json_type(NEW.input_json,'$.task_spec') IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM task_completions c JOIN control_command_requests r ON r.request_id=c.request_id
  JOIN control_effect_attempts a ON a.attempt_id=c.attempt_id
  JOIN workflow_steps s ON s.run_id=c.run_id AND s.evidence_digest=c.payload_digest AND s.outcome='task_verified'
  JOIN workflow_transitions t ON t.run_id=c.run_id AND t.evidence_digest=c.payload_digest AND t.outcome='task_verified'
  WHERE c.run_id=NEW.run_id AND r.state='completed' AND a.state='confirmed'
    AND json_extract(c.payload_json,'$.from_node')=OLD.current_node
    AND json_extract(c.payload_json,'$.prior_attempts')=OLD.attempts
    AND NEW.attempts=OLD.attempts+1 AND NEW.current_node='complete' AND NEW.completed_at=c.created_at
    AND s.node_id=OLD.current_node AND s.attempt=json_extract(c.payload_json,'$.node_attempt')
    AND s.output_json=c.payload_json AND s.output_digest=c.payload_digest
    AND t.from_node=OLD.current_node AND t.to_node=NEW.current_node)
BEGIN SELECT RAISE(ABORT,'task completion receipt required'); END;
