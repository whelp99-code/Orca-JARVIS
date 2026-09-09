CREATE TABLE memory_scoped_settlements (
 outbox_id TEXT PRIMARY KEY REFERENCES memory_scoped_outbox_bindings(outbox_id),
 observation_id TEXT NOT NULL UNIQUE REFERENCES memory_scoped_completion_observations(observation_id),
 receipt_digest TEXT NOT NULL UNIQUE,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
 control_fence INTEGER NOT NULL CHECK(control_fence>0),
 reconcile_fence INTEGER NOT NULL CHECK(reconcile_fence>0),
 settled_at TEXT NOT NULL
);
CREATE TRIGGER scoped_settlement_update BEFORE UPDATE ON memory_scoped_settlements
BEGIN SELECT RAISE(ABORT,'immutable scoped settlement'); END;
CREATE TRIGGER scoped_settlement_delete BEFORE DELETE ON memory_scoped_settlements
BEGIN SELECT RAISE(ABORT,'immutable scoped settlement'); END;
CREATE TRIGGER scoped_settlement_replace BEFORE INSERT ON memory_scoped_settlements
WHEN EXISTS(SELECT 1 FROM memory_scoped_settlements WHERE outbox_id=NEW.outbox_id OR observation_id=NEW.observation_id)
BEGIN SELECT RAISE(ABORT,'scoped settlement already recorded'); END;
CREATE TRIGGER scoped_settlement_binding BEFORE INSERT ON memory_scoped_settlements
WHEN NOT EXISTS(SELECT 1 FROM memory_outbox o JOIN memory_scoped_completion_observations e ON e.outbox_id=o.outbox_id
 JOIN control_command_requests r ON r.request_id=o.action_request_id
 WHERE o.outbox_id=NEW.outbox_id AND o.state='reconciling' AND o.request_profile='scoped-v4'
 AND e.observation_id=NEW.observation_id AND e.reconcile_fence=o.lease_fence
 AND o.lease_fence=NEW.reconcile_fence AND o.lease_expires_at>NEW.settled_at
 AND r.request_id=NEW.control_request_id AND r.lease_fence=NEW.control_fence AND r.state IN ('claimed','uncertain'))
BEGIN SELECT RAISE(ABORT,'scoped settlement binding invalid'); END;
CREATE TRIGGER scoped_terminal_receipt_required BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.request_profile='scoped-v4' AND NEW.state='settled' AND NOT EXISTS(
 SELECT 1 FROM memory_scoped_settlements s WHERE s.outbox_id=NEW.outbox_id
 AND s.receipt_digest=NEW.settlement_receipt_digest AND s.settled_at=NEW.settled_at AND s.reconcile_fence=NEW.lease_fence)
BEGIN SELECT RAISE(ABORT,'scoped settlement receipt required'); END;
