-- Preserve audit identity and outcome while retiring remote authentication metadata.
CREATE TABLE remote_audit_retired_events (
  event_id TEXT PRIMARY KEY,
  event_digest TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type LIKE 'remote.%'),
  outcome TEXT,
  reason_code TEXT,
  created_at TEXT NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES remote_auth_retention_authorizations_v2(authorization_id)
);
CREATE TRIGGER remote_audit_retired_immutable_update BEFORE UPDATE ON remote_audit_retired_events
BEGIN SELECT RAISE(ABORT,'immutable retired remote audit'); END;
CREATE TRIGGER remote_audit_retired_immutable_delete BEFORE DELETE ON remote_audit_retired_events
BEGIN SELECT RAISE(ABORT,'immutable retired remote audit'); END;
CREATE TRIGGER remote_audit_retired_insert_guard BEFORE INSERT ON remote_audit_retired_events
BEGIN
  SELECT RAISE(ABORT,'remote audit retirement evidence required') WHERE NOT EXISTS (
    SELECT 1 FROM personal_operation_audit_events e
    JOIN remote_auth_retention_authorizations_v2 a ON a.authorization_id=NEW.authorization_id
    JOIN retention_jobs j ON j.job_id=a.job_id
    WHERE e.event_id=NEW.event_id AND e.event_digest=NEW.event_digest
      AND e.event_type=NEW.event_type AND e.outcome IS NEW.outcome AND e.reason_code IS NEW.reason_code
      AND e.created_at=NEW.created_at AND a.state='applying'
      AND j.state='claimed' AND j.data_class='audit' AND j.job_key GLOB 'remote-auth:*'
      AND j.lease_fence=a.fence AND j.policy_cutoff=a.cutoff AND j.lease_owner IS NOT NULL
      AND e.created_at<a.cutoff AND a.cutoff<=a.created_at
      AND a.created_at>=j.updated_at AND a.created_at<j.lease_expires_at AND a.created_at<j.expires_at
      AND julianday(a.cutoff)<=julianday(a.created_at)-365
  );
END;
CREATE TRIGGER remote_audit_retirement_delete_guard BEFORE DELETE ON personal_operation_audit_events
WHEN OLD.event_type LIKE 'remote.%'
BEGIN
  SELECT RAISE(ABORT,'remote audit retirement evidence required') WHERE NOT EXISTS (
    SELECT 1 FROM remote_audit_retired_events r
    JOIN remote_auth_retention_authorizations_v2 a ON a.authorization_id=r.authorization_id
    JOIN retention_jobs j ON j.job_id=a.job_id
    WHERE r.event_id=OLD.event_id AND r.event_digest=OLD.event_digest AND a.state='applying'
      AND j.state='claimed' AND j.lease_fence=a.fence AND j.policy_cutoff=a.cutoff
      AND j.lease_owner IS NOT NULL
  );
END;
CREATE TRIGGER remote_audit_retired_replay_guard BEFORE INSERT ON personal_operation_audit_events
BEGIN
  SELECT RAISE(ABORT,'remote audit identity retired') WHERE EXISTS (
    SELECT 1 FROM remote_audit_retired_events WHERE event_id=NEW.event_id OR event_digest=NEW.event_digest
  );
END;
