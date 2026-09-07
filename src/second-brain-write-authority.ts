import type { AuthorityDb } from "./db.js";
import type { SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";
import { persistenceRow } from "./personal-persistence-values.js";
import { memoryHash } from "./memory-candidate-values.js";
import { hasOwnerConfirmedMemoryWriteAuthority } from "./second-brain-write-confirmation.js";

function terminalAuthorityValid(
  row: Readonly<Record<string, unknown>>,
  now: Date,
): boolean {
  switch (row["authority_kind"]) {
    case "explicit_instruction":
    case "approved_decision":
      return row["control_state"] === "approved" && row["control_decision"] === "approve"
        && row["control_request_digest"] === row["control_receipt_digest"]
        && row["control_request_digest"] === row["control_command_digest"]
        && typeof row["control_expires_at"] === "string"
        && Date.parse(row["control_expires_at"]) > now.getTime()
        && row["control_redeemed"] === null && row["control_revoked"] === null;
    case "verified_outcome":
      return row["verification_status"] === "issued"
        && row["verification_candidate_id"] === row["candidate_id"]
        && typeof row["verification_expires_at"] === "string"
        && Date.parse(row["verification_expires_at"]) > now.getTime()
        && row["verification_revoked"] === 0;
    default:
      return false;
  }
}

export function hasSecondBrainWriteAuthority(
  authority: AuthorityDb,
  request: SecondBrainWriteRequestV1,
  now: Date,
): boolean {
  const value = authority.db.prepare(
    `SELECT c.candidate_id,c.state,c.operation,c.required_confirmation,c.content_digest,c.subject_digest,c.purpose,
      c.expires_at,m.policy_sensitivity,m.retention_days,m.candidate_digest,
      m.classification_digest,m.owner_principal,m.authority_expires_at,m.control_receipt_id,
      m.verification_evidence_id,m.created_at,m.control_command_digest,a.authority_id,a.authority_kind,
      r.state AS control_state,r.command_digest AS control_request_digest,r.expires_at AS control_expires_at,
      cr.decision AS control_decision,cr.command_digest AS control_receipt_digest,
      rd.request_id AS control_redeemed,rv.request_id AS control_revoked,
      v.status AS verification_status,v.candidate_id AS verification_candidate_id,
      v.expires_at AS verification_expires_at,
      o.state AS outbox_state,o.request_id AS outbox_request_id,o.request_digest AS outbox_request_digest,
      o.idempotency_key AS outbox_idempotency_key,o.dispatch_fence,o.lease_fence AS outbox_lease_fence,
      o.lease_expires_at AS outbox_lease_expires_at,o.action_request_id,o.action_receipt_id,
      CASE WHEN v.evidence_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM authority_revocations ar
        WHERE ar.reference IN (v.evidence_id,v.verifier_key_id,v.nonce,v.evidence_digest,v.signature,v.attempt_id))
      END AS verification_revoked
     FROM memory_candidates c
     JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     LEFT JOIN memory_candidate_authority_claims a ON a.candidate_id=c.candidate_id
       AND a.classification_digest=m.classification_digest
     LEFT JOIN control_command_requests r ON r.request_id=m.control_request_id
     LEFT JOIN control_command_receipts cr ON cr.request_id=r.request_id
       AND cr.receipt_id=m.control_receipt_id
     LEFT JOIN control_command_redemptions rd ON rd.request_id=r.request_id
     LEFT JOIN control_command_revocations rv ON rv.request_id=r.request_id
     LEFT JOIN memory_candidate_verification_authority v
       ON v.evidence_id=m.verification_evidence_id
     LEFT JOIN memory_outbox o ON o.candidate_id=c.candidate_id
     WHERE c.candidate_id=?`,
  ).get(request.candidate_id);
  if (value === undefined) return false;
  const row = persistenceRow(value);
  const terminalReceipt = row["control_receipt_id"] ?? row["verification_evidence_id"];
  const candidateStateValid = row["state"] === "approved" || (
    row["state"] === "accepted_unsettled" && row["outbox_state"] === "dispatching"
    && row["outbox_request_id"] === request.request_id
    && row["outbox_request_digest"] === request.request_digest
    && row["outbox_idempotency_key"] === request.idempotency_key
    && row["dispatch_fence"] === row["outbox_lease_fence"]
    && typeof row["outbox_lease_expires_at"] === "string"
    && Date.parse(row["outbox_lease_expires_at"]) > now.getTime()
    && typeof row["action_request_id"] === "string" && typeof row["action_receipt_id"] === "string"
  );
  const identityValid = candidateStateValid
    && row["operation"] === request.operation
    && row["candidate_digest"] === request.candidate_digest
    && row["classification_digest"] === request.classification_digest
    && row["owner_principal"] === request.receipt["principal_id"]
    && request.created_at === row["created_at"]
    && request.purpose === row["purpose"] && request.sensitivity === row["policy_sensitivity"]
    && request.retention_days === row["retention_days"]
    && memoryHash("orca-jarvis/memory-content/v1\0", request.payload["content"]) === row["content_digest"]
    && memoryHash("orca-jarvis/memory-subject/v1\0", request.subject) === row["subject_digest"]
    && typeof row["expires_at"] === "string" && Date.parse(row["expires_at"]) > now.getTime();
  if (!identityValid) return false;
  if (row["required_confirmation"] === 1) return hasOwnerConfirmedMemoryWriteAuthority(authority, request, now);
  return request.receipt["decision"] === "auto_staged"
    && request.receipt["issued_at"] === row["created_at"]
    && request.receipt["expires_at"] === row["authority_expires_at"]
    && typeof terminalReceipt === "string" && terminalReceipt.length > 0
    && typeof row["authority_id"] === "string" && row["authority_id"].length > 0
    && typeof row["authority_expires_at"] === "string"
    && Date.parse(row["authority_expires_at"]) > now.getTime()
    && terminalAuthorityValid(row, now);
}
