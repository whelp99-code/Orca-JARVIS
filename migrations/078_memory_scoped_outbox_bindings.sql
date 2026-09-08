-- Content-free receipt consumption bound to exactly one scoped outbox row.
CREATE TABLE memory_scoped_outbox_bindings (
  outbox_id TEXT PRIMARY KEY REFERENCES memory_outbox(outbox_id) DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  request_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  scope_review_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  scope_review_receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  scope_command_digest TEXT NOT NULL,
  source_request_id TEXT NOT NULL,
  source_request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER scoped_outbox_binding_update BEFORE UPDATE ON memory_scoped_outbox_bindings
BEGIN SELECT RAISE(ABORT,'immutable scoped outbox binding'); END;
CREATE TRIGGER scoped_outbox_binding_delete BEFORE DELETE ON memory_scoped_outbox_bindings
BEGIN SELECT RAISE(ABORT,'immutable scoped outbox binding'); END;
CREATE TRIGGER scoped_outbox_binding_replace BEFORE INSERT ON memory_scoped_outbox_bindings
WHEN EXISTS(SELECT 1 FROM memory_scoped_outbox_bindings WHERE outbox_id=NEW.outbox_id
 OR candidate_id=NEW.candidate_id OR scope_review_request_id=NEW.scope_review_request_id
 OR scope_review_receipt_id=NEW.scope_review_receipt_id OR idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'scoped review already consumed'); END;
CREATE TRIGGER scoped_outbox_review_binding BEFORE INSERT ON memory_scoped_outbox_bindings
WHEN EXISTS(SELECT 1 FROM memory_outbox WHERE outbox_id=NEW.outbox_id)
 OR NOT EXISTS(
 SELECT 1 FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id
 WHERE r.request_id=NEW.scope_review_request_id AND a.receipt_id=NEW.scope_review_receipt_id
 AND r.action='memory.scope.review' AND r.state='approved' AND a.decision='approve'
 AND r.command_digest=NEW.scope_command_digest AND a.command_digest=r.command_digest
 AND r.requested_by='principal:owner' AND a.signer_principal_id='principal:owner'
 AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
 AND julianday(NEW.created_at)<julianday(r.expires_at) AND julianday(NEW.created_at)<julianday(a.expires_at)
 AND NOT EXISTS(SELECT 1 FROM control_command_redemptions x WHERE x.request_id=r.request_id)
 AND NOT EXISTS(SELECT 1 FROM control_command_revocations v WHERE v.request_id=r.request_id OR v.receipt_id=a.receipt_id)
 )
BEGIN SELECT RAISE(ABORT,'scoped review binding invalid'); END;
CREATE TRIGGER scoped_outbox_registration_guard BEFORE INSERT ON memory_outbox
WHEN NEW.request_profile='scoped-v4' AND NOT EXISTS(
 SELECT 1 FROM memory_scoped_outbox_bindings b WHERE b.outbox_id=NEW.outbox_id
 AND b.candidate_id=NEW.candidate_id AND b.request_id=NEW.request_id
 AND b.request_digest=NEW.request_digest AND b.idempotency_key=NEW.idempotency_key
 AND b.created_at=NEW.created_at
)
BEGIN SELECT RAISE(ABORT,'scoped outbox binding required'); END;
CREATE TRIGGER legacy_outbox_scoped_binding_guard BEFORE INSERT ON memory_outbox
WHEN NEW.request_profile='legacy' AND EXISTS(SELECT 1 FROM memory_scoped_outbox_bindings b
 WHERE b.outbox_id=NEW.outbox_id OR b.candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT,'scoped binding cannot enqueue legacy request'); END;
