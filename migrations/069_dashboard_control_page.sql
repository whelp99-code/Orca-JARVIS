-- Ordered actionable pages without sorting or decoding settled command payloads.
CREATE INDEX control_command_requests_actionable_page
ON control_command_requests(requested_at,request_id)
WHERE state IN ('pending','approved','failed');
