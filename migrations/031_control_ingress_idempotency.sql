CREATE TABLE control_ingress_requests (
  ingress_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  effect_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX control_ingress_effect_key ON control_ingress_requests(effect_key, request_id);
CREATE TRIGGER control_ingress_immutable_update BEFORE UPDATE ON control_ingress_requests BEGIN
  SELECT RAISE(ABORT, 'immutable control ingress');
END;
CREATE TRIGGER control_ingress_immutable_delete BEFORE DELETE ON control_ingress_requests BEGIN
  SELECT RAISE(ABORT, 'immutable control ingress');
END;
