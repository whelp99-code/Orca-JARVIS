import { canonicalize } from "./canonical.js";
import { validateControlAction } from "./control-actions.js";
import { controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt,
  type ClaimedControlCommand, type ControlCommandRequestInput } from "./control-plane-contract.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { parseTaskExecutionPlan, type TaskExecutionPlanV1 } from "./task-execution-plan.js";
import { assertTaskExecutionBinding } from "./task-execution-staging.js";

/** Read-only authority check. Caller must hold an IMMEDIATE transaction through its ledger write. */
export function assertTaskExecutionAuthority(db: AuthorityDb, command: ClaimedControlCommand,
  now: Date): TaskExecutionPlanV1 {
  const invalid = (): never => { throw new JarvisError("TASK_EXECUTION_AUTHORITY_INVALID"); };
  const time = now.getTime();
  if (!Number.isFinite(time) || command.action !== "task.execute") return invalid();
  validateControlAction(command, { enforceMinimumLevel: true });
  const row = db.db.prepare(`SELECT r.*, x.receipt_id, x.redeemed_at, a.payload_json AS approval_json,
    a.signature AS approval_signature, a.expires_at AS approval_expires, a.key_id AS approval_key,
    a.signer_principal_id AS approval_principal, k.public_key_pem, k.principal_id AS key_principal
    FROM control_command_requests r
    JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
    JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
      AND a.decision='approve' AND a.command_digest=r.command_digest
    JOIN trusted_authority_keys k ON k.key_id=a.key_id
    JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
    WHERE r.request_id=?`).get(command.request_id) as Record<string, unknown> | undefined;
  if (!row || row.state !== "claimed" || row.lease_fence !== command.fence || row.receipt_id !== command.receipt_id
    || row.command_digest !== command.command_digest || row.lease_expires_at !== command.lease_expires_at
    || ![row.lease_expires_at, row.expires_at, row.approval_expires].every(value => Date.parse(String(value)) > time)
    || !Number.isFinite(Date.parse(String(row.redeemed_at))) || Date.parse(String(row.redeemed_at)) > time) return invalid();
  const stored: ControlCommandRequestInput = { schema_version: 1, request_id: String(row.request_id),
    action: String(row.action), action_level: Number(row.action_level) as ControlCommandRequestInput["action_level"],
    target: JSON.parse(String(row.target_json)), args: JSON.parse(String(row.args_json)), reversible: Boolean(row.reversible),
    requested_by: String(row.requested_by), requested_at: String(row.requested_at), expires_at: String(row.expires_at),
    nonce: String(row.nonce) };
  if (controlCommandDigest(stored) !== command.command_digest || stored.action !== command.action
    || stored.action_level !== command.action_level || stored.reversible !== command.reversible
    || canonicalize(stored.target) !== canonicalize(command.target) || canonicalize(stored.args) !== canonicalize(command.args)) {
    return invalid();
  }
  const receipt = JSON.parse(String(row.approval_json)) as CommandApprovalReceipt;
  if (!receipt || receipt.request_id !== command.request_id || receipt.receipt_id !== command.receipt_id
    || receipt.command_digest !== command.command_digest || receipt.decision !== "approve"
    || receipt.signature !== row.approval_signature || receipt.key_id !== row.approval_key
    || receipt.expires_at !== row.approval_expires || receipt.signer_principal_id !== row.approval_principal
    || receipt.signer_principal_id !== row.key_principal
    || !verifyCommandApproval(receipt, String(row.public_key_pem), now)) return invalid();
  if (db.db.prepare(`SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
    UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?) LIMIT 1`)
    .get(command.request_id, command.receipt_id, command.request_id, command.receipt_id, command.command_digest, receipt.key_id)) {
    return invalid();
  }
  const plan = parseTaskExecutionPlan(stored.args.plan);
  assertTaskExecutionBinding(db, plan, now);
  return plan;
}
