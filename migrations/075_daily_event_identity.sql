-- Preserve original event identity across legacy and v2 derived keys.
-- Conflicting historical rows deliberately fail migration; no evidence is rewritten.
CREATE UNIQUE INDEX daily_loop_event_identity_v2
ON daily_loop_runs(loop_date,json_extract(input_json,'$.event_id'))
WHERE record_version=1 AND phase='in_day';
