-- Match the remote-audit retirement predicate and ordering without changing eligibility.
CREATE INDEX remote_audit_retention_due
ON personal_operation_audit_events(created_at,event_id)
WHERE event_type LIKE 'remote.%';
