-- Task 30 additive compatibility: discriminate frozen remember from proof-bound correction.
DROP TRIGGER memory_candidate_confirmation_v3_guard;
DROP TRIGGER memory_candidate_confirmation_v3_redeem;
DROP TRIGGER memory_outbox_v3_transition;
DROP TRIGGER memory_outbox_v3_settlement_guard;

CREATE TRIGGER memory_candidate_confirmation_guard
BEFORE UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
  AND NEW.operation='remember' AND NOT EXISTS (
    SELECT 1 FROM control_command_requests r
    JOIN control_command_receipts a ON a.request_id=r.request_id
    WHERE r.request_id=NEW.confirmation_request_id
      AND a.receipt_id=NEW.confirmation_receipt_id
      AND r.action='memory.confirm' AND r.action_level=3
      AND r.state='approved' AND a.decision='approve'
      AND a.command_digest=r.command_digest
      AND NEW.confirmation_principal_id='local-owner'
      AND r.requested_by='local-owner'
      AND a.signer_principal_id='local-owner'
      AND a.authenticated_session_id='session:local-owner'
      AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
      AND json_extract(r.target_json,'$.subject_digest')=NEW.subject_digest
      AND json_extract(r.target_json,'$.content_digest')=NEW.content_digest
      AND json_extract(r.args_json,'$.operation')=NEW.operation
      AND json_extract(r.args_json,'$.evidence_digest')=NEW.confirmation_evidence_digest
      AND json_extract(a.payload_json,'$.receipt_digest')=NEW.confirmation_receipt_digest
      AND NOT EXISTS (
        SELECT 1 FROM personal_authority_redemptions
        WHERE receipt_id=a.receipt_id OR request_id=r.request_id
      )
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(NEW.expires_at)
      AND julianday(NEW.updated_at)<julianday(r.expires_at)
      AND julianday(NEW.updated_at)<julianday(a.expires_at)
  )
BEGIN SELECT RAISE(ABORT,'memory confirmation authority required'); END;

CREATE TRIGGER memory_candidate_confirmation_v3_guard
BEFORE UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
  AND NEW.operation='correct' AND NOT EXISTS (
    SELECT 1 FROM control_command_requests r
    JOIN control_command_redemptions x
      ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
    JOIN control_command_receipts a
      ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
    WHERE r.request_id=NEW.confirmation_request_id
      AND a.receipt_id=NEW.confirmation_receipt_id
      AND r.action='memory.confirm' AND r.action_level=3
      AND r.state='claimed' AND a.decision='approve'
      AND r.command_digest=a.command_digest
      AND NEW.confirmation_principal_id='principal:owner'
      AND r.requested_by='principal:owner'
      AND json_extract(r.target_json,'$.candidate_id')=NEW.candidate_id
      AND json_extract(r.target_json,'$.candidate_digest')=(
        SELECT candidate_digest FROM memory_candidate_classifications
        WHERE candidate_id=NEW.candidate_id
      )
      AND json_extract(r.target_json,'$.classification_digest')=(
        SELECT classification_digest FROM memory_candidate_classifications
        WHERE candidate_id=NEW.candidate_id
      )
      AND json_extract(r.args_json,'$.operation')='correct'
      AND json_extract(r.args_json,'$.evidence_digest')=NEW.confirmation_evidence_digest
      AND julianday(NEW.updated_at)<julianday(NEW.confirmation_expires_at)
      AND julianday(NEW.updated_at)<julianday(r.expires_at)
      AND julianday(NEW.updated_at)<julianday(a.expires_at)
  )
BEGIN SELECT RAISE(ABORT,'memory correction confirmation required'); END;

CREATE TRIGGER memory_candidate_confirmation_redeem
AFTER UPDATE OF state ON memory_candidates
WHEN OLD.state='awaiting_confirmation' AND NEW.state='approved'
BEGIN
  INSERT INTO personal_authority_redemptions(
    receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at
  ) VALUES(
    NEW.confirmation_receipt_id,NEW.confirmation_request_id,'memory_confirmation',
    NEW.candidate_id,NEW.confirmation_receipt_digest,NEW.updated_at
  );
END;

CREATE TRIGGER memory_outbox_v2_transition
BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'queued:claimed','queued:failed','queued:expired','claimed:dispatching',
  'claimed:failed','claimed:expired','dispatching:reconciling',
  'reconciling:settled','reconciling:conflict'
)
BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_v2_settlement_guard
BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='settled' AND (
  NEW.settlement_receipt_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM memory_reconciliation_events o
    JOIN memory_reconciliation_events s
      ON s.outbox_id=o.outbox_id AND s.attempt_id=o.attempt_id
      AND s.reconcile_fence=o.reconcile_fence
    WHERE o.outbox_id=OLD.outbox_id
      AND o.reconcile_fence=OLD.lease_fence
      AND o.event_type='artifact_observed'
      AND o.observed_artifact_digest=OLD.expected_artifact_digest
      AND s.event_type='settled'
      AND s.effect_digest=NEW.settlement_receipt_digest
  )
)
BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
