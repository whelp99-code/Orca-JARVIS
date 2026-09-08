import { ControlPlane, controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { validateMemoryCandidateScopeProposal } from "./memory-candidate-scope.js";

/** Stage a review only; signing remains the existing owner's explicit action. */
export function stageMemoryScopeReview(authority: AuthorityDb, value: unknown, now: Date) {
  return authority.db.transaction(() => {
    const proposal = validateMemoryCandidateScopeProposal(authority, value, now);
    const requestId = `memory-scope-review:${proposal.proposal_digest.slice(7)}`;
    const control = new ControlPlane(authority);
    const prior = control.get(requestId);
    if (prior !== undefined) {
      if (prior.action !== "memory.scope.review" || canonicalize(prior.args) !== canonicalize({ schema_version: 1, proposal })
        || prior.command_digest !== controlCommandDigest(prior)) throw new JarvisError("MEMORY_SCOPE_REVIEW_INVALID");
      return prior;
    }
    return control.stage({ schema_version: 1, request_id: requestId, action: "memory.scope.review", action_level: 3,
      target: { candidate_id: proposal.candidate_id, proposal_digest: proposal.proposal_digest },
      args: { schema_version: 1, proposal }, reversible: false, requested_by: "principal:owner",
      requested_at: now.toISOString(), expires_at: new Date(Math.min(Date.parse(proposal.expires_at), now.getTime() + 900000)).toISOString(),
      nonce: requestId }, now);
  }).immediate();
}

/** Read a current signed scope review. It does not redeem a receipt or authorize
 * dispatch; the later versioned write path must consume the same review once. */
export function readApprovedMemoryScopeReview(authority: AuthorityDb, value: unknown, requestId: string, now: Date) {
  return authority.db.transaction(() => {
    const proposal = validateMemoryCandidateScopeProposal(authority, value, now);
    const command = new ControlPlane(authority).get(requestId);
    const fail = (): never => { throw new JarvisError("MEMORY_SCOPE_REVIEW_INVALID"); };
    if (command === undefined || command.state !== "approved" || command.action !== "memory.scope.review"
      || command.action_level !== 3 || command.requested_by !== "principal:owner" || command.reversible
      || command.command_digest !== controlCommandDigest(command) || Date.parse(command.expires_at) <= now.getTime()
      || canonicalize(command.target) !== canonicalize({ candidate_id: proposal.candidate_id, proposal_digest: proposal.proposal_digest })
      || canonicalize(command.args) !== canonicalize({ schema_version: 1, proposal })) return fail();
    const row = authority.db.prepare(`SELECT a.receipt_id,a.payload_json,a.key_id,k.public_key_pem FROM control_command_receipts a
      JOIN trusted_authority_keys k ON k.key_id=a.key_id AND k.principal_id='principal:owner'
      JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
      WHERE a.request_id=? AND a.decision='approve' AND a.command_digest=? AND a.signer_principal_id='principal:owner'`)
      .get(requestId, command.command_digest) as { receipt_id: string; payload_json: string; key_id: string; public_key_pem: string } | undefined;
    if (row === undefined) return fail();
    const receipt = JSON.parse(row.payload_json) as CommandApprovalReceipt;
    if (receipt.receipt_id !== row.receipt_id || receipt.request_id !== requestId || receipt.key_id !== row.key_id
      || receipt.command_digest !== command.command_digest || receipt.decision !== "approve"
      || receipt.signer_principal_id !== "principal:owner" || Date.parse(receipt.expires_at) > Date.parse(command.expires_at)
      || !verifyCommandApproval(receipt, row.public_key_pem, now)) return fail();
    const revoked = authority.db.prepare(`SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
      UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?,?)
      UNION ALL SELECT 1 FROM control_command_redemptions WHERE request_id=?
      UNION ALL SELECT 1 FROM memory_scoped_outbox_bindings WHERE scope_review_request_id=? OR scope_review_receipt_id=? LIMIT 1`)
      .get(requestId, receipt.receipt_id, requestId, receipt.receipt_id, command.command_digest, receipt.key_id,
        receipt.nonce, receipt.signature, requestId, requestId, receipt.receipt_id);
    if (revoked !== undefined) return fail();
    return Object.freeze({ schema_version: 1 as const, writes_authorized: false as const, proposal,
      control_request_id: requestId, control_receipt_id: receipt.receipt_id, command_digest: command.command_digest,
      expires_at: receipt.expires_at });
  })();
}
