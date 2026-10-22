CREATE TABLE company_progress_intents (
  operation_id TEXT PRIMARY KEY,
  provider_instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  operation TEXT NOT NULL,
  reserve_request_json TEXT NOT NULL CHECK(json_valid(reserve_request_json)),
  expected_checkpoint_json TEXT NOT NULL CHECK(json_valid(expected_checkpoint_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX company_progress_intents_scope
  ON company_progress_intents(provider_instance_id, workspace_id);
CREATE TRIGGER company_progress_intents_no_update
BEFORE UPDATE ON company_progress_intents
BEGIN SELECT RAISE(ABORT, 'COMPANY_PROGRESS_INTENT_IMMUTABLE'); END;
CREATE TRIGGER company_progress_intents_no_delete
BEFORE DELETE ON company_progress_intents
BEGIN SELECT RAISE(ABORT, 'COMPANY_PROGRESS_INTENT_IMMUTABLE'); END;
