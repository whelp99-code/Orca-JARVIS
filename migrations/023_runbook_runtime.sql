CREATE TABLE runbook_definitions (
  runbook_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  name TEXT NOT NULL,
  minimum_action_level INTEGER NOT NULL CHECK(minimum_action_level BETWEEN 0 AND 5),
  spec_json TEXT NOT NULL,
  spec_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TRIGGER runbook_definitions_immutable_update BEFORE UPDATE ON runbook_definitions BEGIN SELECT RAISE(ABORT,'immutable runbook definition'); END;
CREATE TRIGGER runbook_definitions_immutable_delete BEFORE DELETE ON runbook_definitions BEGIN SELECT RAISE(ABORT,'immutable runbook definition'); END;

CREATE TABLE runbook_executions (
  execution_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  runbook_id TEXT NOT NULL REFERENCES runbook_definitions(runbook_id),
  state TEXT NOT NULL CHECK(state IN ('completed','failed','escalated')),
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER runbook_executions_immutable_update BEFORE UPDATE ON runbook_executions BEGIN SELECT RAISE(ABORT,'immutable runbook execution'); END;
CREATE TRIGGER runbook_executions_immutable_delete BEFORE DELETE ON runbook_executions BEGIN SELECT RAISE(ABORT,'immutable runbook execution'); END;
