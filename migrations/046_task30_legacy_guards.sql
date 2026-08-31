-- Task 30 additive compatibility: restore frozen deletion authority and reclaim guards.
CREATE TRIGGER memory_deletion_initial_state
BEFORE INSERT ON memory_deletion_requests
WHEN NEW.state<>'requested' OR NEW.confirmation_request_id IS NOT NULL
  OR NEW.confirmation_receipt_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'memory deletion must start requested'); END;
CREATE TRIGGER memory_deletion_identity_immutable
BEFORE UPDATE OF deletion_id,correlation_id,idempotency_key,operation,subject_digest,
  scope_digest,target_digest,args_digest,requested_by,expires_at,created_at
  ON memory_deletion_requests
BEGIN SELECT RAISE(ABORT,'immutable memory deletion identity'); END;
CREATE TRIGGER memory_deletion_authority_immutable
BEFORE UPDATE OF confirmation_request_id,confirmation_receipt_id,confirmation_receipt_digest
  ON memory_deletion_requests
WHEN OLD.confirmation_request_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable memory deletion authority'); END;
CREATE TRIGGER memory_deletion_transition
BEFORE UPDATE OF state ON memory_deletion_requests
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'requested:approved','requested:rejected','requested:expired','requested:failed',
  'approved:queued','approved:rejected','approved:expired','approved:failed',
  'queued:applying','queued:failed','queued:uncertain','queued:expired',
  'applying:tombstoned','applying:failed','applying:uncertain',
  'tombstoned:failed','tombstoned:uncertain'
)
BEGIN SELECT RAISE(ABORT,'memory deletion transition invalid'); END;
CREATE TRIGGER memory_deletion_legacy_settlement_block
BEFORE UPDATE OF state ON memory_deletion_requests
WHEN OLD.state='tombstoned' AND NEW.state='settled'
BEGIN SELECT RAISE(ABORT,'memory deletion provider proof required'); END;
CREATE TRIGGER memory_deletion_current_lease_guard
BEFORE UPDATE OF state ON memory_deletion_requests
WHEN NEW.state IN ('tombstoned','settled') AND NOT (
  OLD.lease_owner IS NOT NULL AND OLD.lease_fence>0
  AND NEW.lease_fence=OLD.lease_fence
  AND julianday(NEW.updated_at)<julianday(OLD.lease_expires_at)
  AND julianday(NEW.updated_at)<julianday(OLD.expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory deletion current lease required'); END;
CREATE TRIGGER memory_deletion_approval_guard
BEFORE UPDATE OF state ON memory_deletion_requests
WHEN NEW.state='approved' AND NOT EXISTS (
  SELECT 1 FROM control_command_requests r
  JOIN control_command_receipts a ON a.request_id=r.request_id
  WHERE r.request_id=NEW.confirmation_request_id
    AND a.receipt_id=NEW.confirmation_receipt_id
    AND r.action='memory.delete' AND r.state='approved' AND a.decision='approve'
    AND a.command_digest=r.command_digest AND r.requested_by='local-owner'
    AND a.signer_principal_id=r.requested_by
    AND a.authenticated_session_id='session:local-owner'
    AND json_extract(r.target_json,'$.deletion_id')=NEW.deletion_id
    AND json_extract(r.target_json,'$.subject_digest')=NEW.subject_digest
    AND json_extract(r.target_json,'$.scope_digest')=NEW.scope_digest
    AND json_extract(r.target_json,'$.target_digest')=NEW.target_digest
    AND json_extract(r.args_json,'$.operation')=NEW.operation
    AND json_extract(r.args_json,'$.args_digest')=NEW.args_digest
    AND json_extract(a.payload_json,'$.receipt_digest')=NEW.confirmation_receipt_digest
    AND NOT EXISTS (
      SELECT 1 FROM personal_authority_redemptions
      WHERE receipt_id=a.receipt_id OR request_id=r.request_id
    )
    AND julianday(NEW.updated_at)<julianday(r.expires_at)
    AND julianday(NEW.updated_at)<julianday(a.expires_at)
    AND julianday(NEW.expires_at)<=julianday(r.expires_at)
    AND julianday(NEW.expires_at)<=julianday(a.expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory deletion approval required'); END;
CREATE TRIGGER memory_deletion_redeem
AFTER UPDATE OF state ON memory_deletion_requests
WHEN NEW.state='approved'
BEGIN
  INSERT INTO personal_authority_redemptions(
    receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at
  ) VALUES(
    NEW.confirmation_receipt_id,NEW.confirmation_request_id,'memory_deletion',
    NEW.deletion_id,NEW.confirmation_receipt_digest,NEW.updated_at
  );
END;
CREATE TRIGGER memory_deletion_claim_guard
BEFORE UPDATE OF lease_fence ON memory_deletion_requests
WHEN OLD.lease_fence=0 AND NOT (
  NEW.lease_fence=1 AND OLD.state='queued' AND NEW.state='applying'
  AND NEW.lease_owner IS NOT NULL
  AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)
  AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory deletion claim invalid'); END;
CREATE TRIGGER memory_deletion_reclaim_guard
BEFORE UPDATE OF lease_fence ON memory_deletion_requests
WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence
  AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (
    NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL
    AND NEW.lease_owner<>OLD.lease_owner
    AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)
    AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)
    AND NEW.state=OLD.state
  )
BEGIN SELECT RAISE(ABORT,'memory deletion reclaim invalid'); END;
CREATE TRIGGER memory_deletion_active_lease
BEFORE UPDATE OF lease_owner,lease_fence ON memory_deletion_requests
WHEN OLD.lease_owner IS NOT NULL
  AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner)
    OR NEW.lease_fence<>OLD.lease_fence)
  AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'memory deletion active lease exists'); END;
CREATE TRIGGER memory_deletion_lease_expiry_guard
BEFORE UPDATE OF lease_expires_at ON memory_deletion_requests
WHEN NEW.lease_owner IS NOT NULL AND (
  (OLD.lease_fence>0 AND NEW.lease_fence=OLD.lease_fence
    AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at))
  OR julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at)
  OR julianday(NEW.lease_expires_at)>julianday(NEW.expires_at)
  OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0
)
BEGIN SELECT RAISE(ABORT,'memory deletion lease expiry invalid'); END;
CREATE TRIGGER memory_deletion_tombstone_guard
BEFORE UPDATE OF state ON memory_deletion_requests
WHEN OLD.state='applying' AND NEW.state='tombstoned' AND NOT EXISTS (
  SELECT 1 FROM memory_tombstones
  WHERE deletion_id=OLD.deletion_id AND subject_digest=OLD.subject_digest
    AND scope_digest=OLD.scope_digest AND target_digest=OLD.target_digest
    AND args_digest=OLD.args_digest
    AND approval_request_id=OLD.confirmation_request_id
    AND approval_receipt_id=OLD.confirmation_receipt_id
    AND approval_receipt_digest=OLD.confirmation_receipt_digest
    AND effect_lease_owner=OLD.lease_owner
    AND effect_lease_fence=OLD.lease_fence
)
BEGIN SELECT RAISE(ABORT,'memory tombstone required'); END;
CREATE TRIGGER memory_tombstone_insert_guard
BEFORE INSERT ON memory_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM memory_deletion_requests d
  JOIN personal_authority_redemptions x
    ON x.receipt_id=d.confirmation_receipt_id
    AND x.request_id=d.confirmation_request_id
  WHERE d.deletion_id=NEW.deletion_id AND d.state='applying'
    AND d.subject_digest=NEW.subject_digest AND d.scope_digest=NEW.scope_digest
    AND d.target_digest=NEW.target_digest AND d.args_digest=NEW.args_digest
    AND d.confirmation_request_id=NEW.approval_request_id
    AND d.confirmation_receipt_id=NEW.approval_receipt_id
    AND d.confirmation_receipt_digest=NEW.approval_receipt_digest
    AND julianday(d.lease_expires_at)>julianday(NEW.created_at)
)
BEGIN SELECT RAISE(ABORT,'memory tombstone authority required'); END;
CREATE TRIGGER memory_tombstone_current_lease_guard
BEFORE INSERT ON memory_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM memory_deletion_requests
  WHERE deletion_id=NEW.deletion_id AND state='applying'
    AND lease_owner=NEW.effect_lease_owner
    AND lease_fence=NEW.effect_lease_fence
    AND julianday(NEW.created_at)<julianday(lease_expires_at)
    AND julianday(NEW.created_at)<julianday(expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory deletion current lease required'); END;
CREATE TRIGGER memory_tombstones_immutable_update
BEFORE UPDATE ON memory_tombstones
BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;
CREATE TRIGGER memory_tombstones_immutable_delete
BEFORE DELETE ON memory_tombstones
BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;

