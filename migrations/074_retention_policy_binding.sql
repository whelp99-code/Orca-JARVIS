ALTER TABLE retention_jobs ADD COLUMN policy_cutoff TEXT
  CHECK(policy_cutoff IS NULL OR (
    strftime('%Y-%m-%dT%H:%M:%fZ',policy_cutoff) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',policy_cutoff)=policy_cutoff
    AND julianday(policy_cutoff)<=julianday(created_at)
  ));

CREATE TRIGGER retention_policy_cutoff_immutable
BEFORE UPDATE OF policy_cutoff ON retention_jobs
WHEN NEW.policy_cutoff IS NOT OLD.policy_cutoff
BEGIN SELECT RAISE(ABORT,'immutable retention policy cutoff'); END;
