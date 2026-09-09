-- Content-free current-read observations, not settlement or reusable authority.
CREATE TABLE memory_scoped_completion_observations (
 observation_id TEXT PRIMARY KEY,
 outbox_id TEXT NOT NULL REFERENCES memory_scoped_outbox_bindings(outbox_id),
 attempt_id TEXT NOT NULL REFERENCES memory_outbox_attempts(attempt_id),
 reconcile_fence INTEGER NOT NULL CHECK(reconcile_fence>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 evidence_digest TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 observed_at TEXT NOT NULL,
 authorized_until TEXT NOT NULL,
 UNIQUE(outbox_id,reconcile_fence),
 CHECK(julianday(observed_at) IS NOT NULL AND julianday(authorized_until)>julianday(observed_at))
);
CREATE TRIGGER scoped_completion_update BEFORE UPDATE ON memory_scoped_completion_observations
BEGIN SELECT RAISE(ABORT,'immutable scoped completion observation'); END;
CREATE TRIGGER scoped_completion_delete BEFORE DELETE ON memory_scoped_completion_observations
BEGIN SELECT RAISE(ABORT,'immutable scoped completion observation'); END;
CREATE TRIGGER scoped_completion_replace BEFORE INSERT ON memory_scoped_completion_observations
WHEN EXISTS(SELECT 1 FROM memory_scoped_completion_observations
 WHERE observation_id=NEW.observation_id OR (outbox_id=NEW.outbox_id AND reconcile_fence=NEW.reconcile_fence))
BEGIN SELECT RAISE(ABORT,'scoped completion observation already recorded'); END;
CREATE TRIGGER scoped_completion_binding BEFORE INSERT ON memory_scoped_completion_observations
WHEN NOT EXISTS(
 SELECT 1 FROM memory_outbox o JOIN memory_outbox_attempts a ON a.outbox_id=o.outbox_id
 WHERE o.outbox_id=NEW.outbox_id AND o.request_profile='scoped-v4' AND o.state='reconciling'
 AND o.lease_fence=NEW.reconcile_fence AND o.dispatch_fence=NEW.dispatch_fence
 AND o.lease_owner IS NOT NULL AND o.lease_expires_at>NEW.observed_at AND o.updated_at<=NEW.observed_at
 AND a.attempt_id=NEW.attempt_id AND a.dispatch_fence=NEW.dispatch_fence
 AND a.request_digest=o.request_digest AND a.outcome='accepted'
 AND a.acceptance_receipt_digest IS NOT NULL AND a.accepted_result_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'scoped completion observation binding invalid'); END;
