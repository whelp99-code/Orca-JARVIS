-- Keep malformed historical JSON rows intact; readers select valid documents
-- and still validate the selected workflow and original approval evidence.
CREATE INDEX workflow_runs_task_page
ON workflow_runs(json_extract(input_json,'$.task_id'),created_at DESC,run_id DESC)
WHERE json_valid(input_json);

CREATE INDEX control_task_execution_page
ON control_command_requests(json_extract(target_json,'$.task_id'),requested_at DESC,request_id DESC)
WHERE action='task.execute' AND json_valid(target_json);

CREATE INDEX control_workflow_start_run
ON control_command_requests(json_extract(args_json,'$.run_id'),request_id)
WHERE action='workflow.start' AND json_valid(args_json);

CREATE INDEX control_effect_request_type
ON control_command_effects(request_id,effect_type);
