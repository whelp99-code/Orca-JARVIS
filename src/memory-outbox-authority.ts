import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { hasSecondBrainWriteAuthority } from "./second-brain-write-authority.js";
import type { MemoryOutboxActionV2 } from "./memory-outbox-types.js";
import { memoryV1Hash } from "./memory-outbox-values.js";

export function requireMemoryOutboxAuthority(
  authority: AuthorityDb,
  action: MemoryOutboxActionV2,
  now: Date,
  providerPreflight = true,
): void {
  const request = action.request;
  if (providerPreflight && !hasSecondBrainWriteAuthority(authority, request, now)) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const row = authority.db.prepare(
    `SELECT c.state,c.subject_digest,c.content_digest,c.purpose,c.expires_at,
      m.policy_sensitivity,m.retention_days,m.candidate_digest,m.classification_digest,
      r.state AS action_state,r.command_digest AS action_digest,x.receipt_id AS redeemed_receipt,
      a.decision AS action_decision,a.command_digest AS receipt_digest,a.expires_at AS receipt_expires
     FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     JOIN control_command_requests r ON r.request_id=?
     JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=?
     JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
     WHERE c.candidate_id=?`,
  ).get(action.command.request_id, action.command.fence, request.candidate_id) as Record<string, unknown> | undefined;
  const content = request.payload["content"];
  if (!row || (row.state !== "approved" && (!providerPreflight && row.state !== "queued"))
    || row.action_state !== "claimed" || row.action_decision !== "approve"
    || row.action_digest !== action.command.command_digest || row.receipt_digest !== action.command.command_digest
    || row.redeemed_receipt !== action.command.receipt_id || row.candidate_digest !== request.candidate_digest
    || row.classification_digest !== request.classification_digest || row.purpose !== request.purpose
    || row.policy_sensitivity !== request.sensitivity || row.retention_days !== request.retention_days
    || row.subject_digest !== memoryV1Hash("subject", request.subject) || typeof content !== "string"
    || row.content_digest !== memoryV1Hash("content", content)
    || Date.parse(String(row.expires_at)) <= now.getTime() || Date.parse(String(row.receipt_expires)) <= now.getTime()) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const revoked = authority.db.prepare(
    `SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
     UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?) LIMIT 1`,
  ).get(action.command.request_id, action.command.receipt_id, action.command.request_id,
    action.command.receipt_id, action.command.command_digest);
  if (revoked !== undefined) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
}
