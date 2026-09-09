import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import { controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane-contract.js";
import { validateControlAction } from "./control-actions.js";
import { JarvisError } from "./db.js";
import { MemoryOutboxRecordReader } from "./memory-outbox-record.js";
import { parseMemoryOutboxAction, type MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import { readRegisteredMemoryScopeReview } from "./memory-scope-review.js";
import { readMemoryScopedReconciliationRequest, type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";
import { hasDispatchedScopedSourceAuthority } from "./second-brain-write-authority.js";

const fail = (): never => { throw new JarvisError("SCOPED_SETTLEMENT_AUTHORITY_INVALID"); };
/** Validate spent authority at its original times against current revocations
 * and suppression. This issues no write grant. Caller must retain the same DB
 * transaction through current read/fence checks and any eventual settlement. */
export function readMemoryScopedSettlementAuthority(options: MemoryScopedReconcileOptions,
  outboxId: string, now: Date, roots: MemoryOutboxSpoolRoots = {}) {
  try { return options.authority.db.transaction(() => {
    const db = options.authority.db;
    const request = readMemoryScopedReconciliationRequest(options, outboxId, now);
    const row = db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(outboxId) as Record<string, any>;
    const sent = new Date(row.dispatched_at), control = new ControlPlane(options.authority);
    const command = control.get(row.action_request_id);
    if (command === undefined || !["claimed", "uncertain"].includes(command.state)
      || command.action !== "memory.outbox.dispatch" || command.reversible
      || command.command_digest !== controlCommandDigest(command) || command.command_digest !== row.action_command_digest)
      return fail();
    validateControlAction(command, { enforceMinimumLevel: true, levelErrorCode: "SCOPED_SETTLEMENT_AUTHORITY_INVALID" });
    const claim = new MemoryOutboxRecordReader(options.authority).command(outboxId);
    const receiptRow = db.prepare(`SELECT x.receipt_id,x.redeemed_at,a.payload_json,a.signature,a.key_id,
      k.public_key_pem,k.principal_id FROM control_command_redemptions x
      JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=x.request_id
      JOIN trusted_authority_keys k ON k.key_id=a.key_id
      JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
      WHERE x.request_id=? AND x.lease_fence=?`).get(command.request_id, claim.fence) as Record<string, any> | undefined;
    if (receiptRow === undefined || receiptRow.receipt_id !== row.action_receipt_id || claim.receipt_id !== row.action_receipt_id)
      return fail();
    const receipt = JSON.parse(receiptRow.payload_json) as CommandApprovalReceipt;
    const redeemed = new Date(receiptRow.redeemed_at);
    if (!Number.isFinite(redeemed.getTime()) || redeemed.toISOString() !== receiptRow.redeemed_at || redeemed > sent
      || Date.parse(row.created_at) < redeemed.getTime() || Date.parse(command.expires_at) <= sent.getTime()
      || receipt.receipt_id !== receiptRow.receipt_id || receipt.request_id !== command.request_id
      || receipt.command_digest !== command.command_digest || receipt.key_id !== receiptRow.key_id
      || receipt.signature !== receiptRow.signature || receipt.signer_principal_id !== receiptRow.principal_id
      || receipt.decision !== "approve" || !verifyCommandApproval(receipt, receiptRow.public_key_pem, redeemed)
      || !verifyCommandApproval(receipt, receiptRow.public_key_pem, sent)) return fail();
    const revoked = db.prepare(`SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
      UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?,?) LIMIT 1`)
      .get(command.request_id, receipt.receipt_id, command.request_id, command.command_digest,
        receipt.receipt_id, receipt.key_id, receipt.nonce, receipt.signature);
    if (revoked !== undefined) return fail();
    const action = parseMemoryOutboxAction(claim, sent, roots);
    if (canonicalize(action.request) !== canonicalize(request.source_request)
      || action.expected_artifact.page_id !== row.expected_page_id || action.expected_artifact.sid !== row.expected_sid
      || action.expected_artifact.source_digest !== row.expected_artifact_digest
      || !hasDispatchedScopedSourceAuthority(options.authority, request.source_request, outboxId, row.dispatch_fence, sent)) return fail();
    const binding = request.preparation.binding;
    const reviewCommand = control.get(binding.control_request_id);
    const review = readRegisteredMemoryScopeReview(options.authority, reviewCommand?.args.proposal,
      binding.control_request_id, outboxId, sent);
    const proposal = review.proposal;
    const identity = { schema_version: 1, operation: "remember", candidate_id: proposal.candidate_id,
      candidate_digest: proposal.candidate_digest, classification_digest: proposal.classification_digest,
      source_digest: proposal.source_digest, owner: proposal.scope.owner, projects: proposal.scope.projects,
      policy_revision: proposal.scope.policy_revision };
    if (canonicalize(identity) !== canonicalize(binding.identity) || review.control_receipt_id !== binding.control_receipt_id
      || review.command_digest !== binding.command_digest || review.expires_at !== binding.expires_at
      || proposal.proposal_digest !== binding.proposal_digest) return fail();
    return Object.freeze({ kind: "spent_authority_currently_unrevoked" as const,
      outbox_id: outboxId, request_id: request.request_id, request_digest: request.request_digest,
      control_request_id: command.request_id, control_receipt_id: receipt.receipt_id,
      control_fence: claim.fence, dispatch_fence: row.dispatch_fence as number, dispatched_at: sent.toISOString(),
      checked_at: now.toISOString() });
  }).immediate(); } catch { return fail(); }
}
