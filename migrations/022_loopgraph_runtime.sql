CREATE TABLE loop_definitions (
  loop_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','retired')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER loop_definitions_immutable_update BEFORE UPDATE OF loop_id,version,name,spec_json,spec_digest,created_at ON loop_definitions BEGIN SELECT RAISE(ABORT,'immutable loop definition'); END;
CREATE TRIGGER loop_definitions_immutable_delete BEFORE DELETE ON loop_definitions BEGIN SELECT RAISE(ABORT,'immutable loop definition'); END;

CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES loop_definitions(loop_id),
  state TEXT NOT NULL CHECK(state IN ('pending','running','waiting_approval','verifying','recovering','completed','failed','uncertain','cancelled')),
  current_node TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT
);
CREATE INDEX workflow_runs_state ON workflow_runs(state,updated_at,run_id);
CREATE TRIGGER workflow_run_identity_immutable BEFORE UPDATE OF run_id,loop_id,correlation_id,input_json,budget_json,created_at ON workflow_runs BEGIN SELECT RAISE(ABORT,'immutable workflow identity'); END;

CREATE TABLE workflow_steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  outcome TEXT NOT NULL,
  output_json TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  evidence_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,node_id,attempt)
);
CREATE TRIGGER workflow_steps_immutable_update BEFORE UPDATE ON workflow_steps BEGIN SELECT RAISE(ABORT,'immutable workflow step'); END;
CREATE TRIGGER workflow_steps_immutable_delete BEFORE DELETE ON workflow_steps BEGIN SELECT RAISE(ABORT,'immutable workflow step'); END;

CREATE TABLE workflow_transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER workflow_transitions_immutable_update BEFORE UPDATE ON workflow_transitions BEGIN SELECT RAISE(ABORT,'immutable workflow transition'); END;
CREATE TRIGGER workflow_transitions_immutable_delete BEFORE DELETE ON workflow_transitions BEGIN SELECT RAISE(ABORT,'immutable workflow transition'); END;
