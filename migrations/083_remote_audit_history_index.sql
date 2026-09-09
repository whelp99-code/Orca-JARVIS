-- Bound history verification to one authorization batch in canonical event order.
CREATE INDEX remote_audit_history_authorization
ON remote_audit_retired_events(authorization_id,created_at,event_id);
