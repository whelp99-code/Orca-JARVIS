import { canonicalize } from "./canonical.js";
import { verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import { providerWriteReceipt } from "./memory-candidate-dispatch-receipts.js";
import { memoryHash } from "./memory-candidate-values.js";
import type { SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";

/** Consume the already committed owner decision without relabeling the source as verified. */
export function hasOwnerConfirmedMemoryWriteAuthority(
  authority: AuthorityDb, request: SecondBrainWriteRequestV1, now: Date,
): boolean {
  // V1 confirmation does not sign the correction target. Corrections must use
  // the existing V2 target/delegation contract, never this remember authority.
  if (request.operation !== "remember") return false;
  const row = authority.db.prepare(
    `SELECT r.request_id,r.command_digest,r.expires_at AS command_expires_at,
      a.receipt_id,a.payload_json,a.issued_at,a.expires_at AS receipt_expires_at,
      k.public_key_pem,c.expires_at,c.confirmation_expires_at,c.confirmation_receipt_digest
     FROM memory_candidates c
     JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     JOIN memory_candidate_owner_decisions d ON d.candidate_id=c.candidate_id AND d.decision='confirm'
       AND d.control_request_id=c.confirmation_request_id AND d.control_receipt_id=c.confirmation_receipt_id
     JOIN memory_candidate_decision_attempts t ON t.attempt_id=d.attempt_id AND t.state='applied'
       AND t.control_request_id=d.control_request_id
     JOIN memory_candidate_decision_families f ON f.family_digest=t.family_digest
       AND f.candidate_id=c.candidate_id AND f.decision='confirm' AND f.content_digest=c.content_digest
       AND f.candidate_digest=m.candidate_digest AND f.classification_digest=m.classification_digest
     JOIN control_command_requests r ON r.request_id=d.control_request_id
       AND r.command_digest=d.command_digest AND r.action='memory.confirm' AND r.action_level=3
       AND r.requested_by='principal:owner' AND r.state IN ('approved','claimed','completed')
       AND json_extract(r.target_json,'$.candidate_id')=c.candidate_id
       AND json_extract(r.target_json,'$.candidate_digest')=m.candidate_digest
       AND json_extract(r.target_json,'$.classification_digest')=m.classification_digest
       AND json_extract(r.args_json,'$.schema_version')=1 AND json_extract(r.args_json,'$.decision')='confirm'
       AND json_extract(r.args_json,'$.operation')=c.operation
       AND json_extract(r.args_json,'$.content_digest')=c.content_digest
       AND json_extract(r.args_json,'$.review_spool_digest')=c.confirmation_evidence_digest
     JOIN control_command_receipts a ON a.receipt_id=d.control_receipt_id AND a.request_id=r.request_id
       AND a.decision='approve' AND a.command_digest=r.command_digest AND a.signer_principal_id='principal:owner'
     JOIN personal_authority_redemptions x ON x.receipt_id=a.receipt_id AND x.request_id=r.request_id
       AND x.authority_kind='memory_confirmation' AND x.subject_id=c.candidate_id
       AND x.binding_digest=c.confirmation_receipt_digest
     JOIN trusted_authority_keys k ON k.key_id=a.key_id AND k.principal_id=a.signer_principal_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE c.candidate_id=? AND c.required_confirmation=1 AND c.confirmation_principal_id='principal:owner'`,
  ).get(request.candidate_id) as { request_id: string; command_digest: string; command_expires_at: string;
    receipt_id: string; payload_json: string; issued_at: string; receipt_expires_at: string; public_key_pem: string;
    expires_at: string; confirmation_expires_at: string; confirmation_receipt_digest: string } | undefined;
  if (row === undefined) return false;
  try {
    const receipt = JSON.parse(row.payload_json) as CommandApprovalReceipt;
    const expiry = Math.min(Date.parse(row.command_expires_at), Date.parse(row.receipt_expires_at),
      Date.parse(row.expires_at), Date.parse(row.confirmation_expires_at));
    if (!(expiry > now.getTime()) || request.expires_at !== new Date(expiry).toISOString()
      || receipt.receipt_id !== row.receipt_id || receipt.request_id !== row.request_id
      || receipt.command_digest !== row.command_digest || receipt.issued_at !== row.issued_at
      || receipt.expires_at !== row.receipt_expires_at || receipt.signer_principal_id !== "principal:owner"
      || !verifyCommandApproval(receipt, row.public_key_pem, now)
      || memoryHash("orca-jarvis/memory-confirmation-receipt/v1\0", receipt) !== row.confirmation_receipt_digest) return false;
    const expectedReceipt = providerWriteReceipt({ ...request, operation: request.operation }, {
      control_receipt_id: row.receipt_id, principal_id: "principal:owner", issued_at: row.issued_at,
      expires_at: new Date(expiry).toISOString(), decision: "owner_confirmed",
    });
    if (canonicalize(request.receipt) !== canonicalize(expectedReceipt)) return false;
    return authority.db.prepare(
      `SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
       UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?,?) LIMIT 1`,
    ).get(row.request_id, row.receipt_id, row.request_id, row.receipt_id, row.command_digest,
      receipt.key_id, receipt.nonce, receipt.signature) === undefined;
  } catch { return false; }
}
