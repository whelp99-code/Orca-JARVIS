import { canonicalize } from "./canonical.js";
import { validateControlAction } from "./control-actions.js";
import { controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt,
  type ControlCommandRequestInput } from "./control-plane-contract.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { MemoryCorrectionRecord } from "./memory-correction-store.js";

export function invalidCorrectionControl(): never {
  throw new JarvisError("MEMORY_CORRECTION_CONTROL_EVIDENCE_INVALID");
}
export type CorrectionControlRow = MemoryCorrectionRecord & {
  readonly control_command_digest: string; readonly dispatched_at: string;
  readonly created_at: string; readonly settled_at: string;
};

function command(row: Record<string, unknown>, target: string, args: string): ControlCommandRequestInput {
  return { schema_version: 1, request_id: String(row.request_id), action: String(row.action),
    action_level: Number(row.action_level) as ControlCommandRequestInput["action_level"],
    target: JSON.parse(target) as Record<string, unknown>, args: JSON.parse(args) as Record<string, unknown>,
    reversible: Boolean(row.reversible), requested_by: String(row.requested_by),
    requested_at: String(row.requested_at), expires_at: String(row.expires_at), nonce: String(row.nonce) };
}

function validateShape(input: ControlCommandRequestInput, record: CorrectionControlRow): void {
  validateControlAction(input, { enforceMinimumLevel: true, levelErrorCode: "MEMORY_CORRECTION_CONTROL_EVIDENCE_INVALID" });
  if (input.action !== "memory.outbox.dispatch" || input.action_level !== 3 || input.reversible
    || input.requested_by !== "principal:owner" || input.args.schema_version !== 3 || input.args.lane !== "correction"
    || controlCommandDigest(input) !== record.control_command_digest
    || input.request_id !== record.control_request_id || input.target.candidate_id !== record.candidate_id
    || !/^sha256:[0-9a-f]{64}$/.test(String(input.target.candidate_digest))
    || !/^sha256:[0-9a-f]{64}$/.test(String(input.target.classification_digest))) invalidCorrectionControl();
  for (const name of ["lane_id", "provider_instance_id", "target_manifest_digest", "scope_digest", "payload_digest", "spool_digest", "expires_at"] as const) {
    if (input.args[name] !== record[name]) invalidCorrectionControl();
  }
}

/** Called before compaction; the immutable snapshot contains no correction content. */
export function captureCorrectionControlBinding(authority: AuthorityDb, record: CorrectionControlRow): void {
  const prior = authority.db.prepare("SELECT 1 FROM memory_correction_control_bindings WHERE correction_id=?").get(record.correction_id);
  if (prior !== undefined) return;
  const row = authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
    .get(record.control_request_id) as Record<string, unknown> | undefined;
  if (row === undefined || row.command_digest !== record.control_command_digest) invalidCorrectionControl();
  const input = command(row, String(row.target_json), String(row.args_json));
  validateShape(input, record);
  authority.db.prepare("INSERT INTO memory_correction_control_bindings VALUES(?,?,?)")
    .run(record.correction_id, canonicalize(input.target), canonicalize(input.args));
}

export function correctionCommandAuthority(authority: AuthorityDb, record: CorrectionControlRow,
  row: Record<string, unknown>) {
  const snapshot = authority.db.prepare("SELECT target_json,args_json FROM memory_correction_control_bindings WHERE correction_id=?")
    .get(record.correction_id) as { target_json: string; args_json: string } | undefined;
  const input = command(row, snapshot?.target_json ?? String(row.target_json), snapshot?.args_json ?? String(row.args_json));
  validateShape(input, record);
  if (row.command_digest !== record.control_command_digest) invalidCorrectionControl();
  const fence = Number(row.lease_fence);
  const binding = authority.db.prepare(
    `SELECT x.receipt_id,x.redeemed_at,a.payload_json,a.signature,k.public_key_pem,k.principal_id
     FROM control_command_redemptions x JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
     JOIN trusted_authority_keys k ON k.key_id=a.key_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE x.request_id=? AND x.lease_fence=? AND a.request_id=x.request_id`,
  ).get(input.request_id,fence) as { receipt_id: string; redeemed_at: string; payload_json: string;
    signature: string; public_key_pem: string; principal_id: string } | undefined;
  if (!Number.isSafeInteger(fence) || fence < 1 || binding === undefined
    || binding.receipt_id !== record.control_receipt_id) invalidCorrectionControl();
  const receipt = JSON.parse(binding.payload_json) as CommandApprovalReceipt;
  const redeemed = new Date(binding.redeemed_at); const dispatched = new Date(record.dispatched_at);
  if (receipt.signature !== binding.signature || receipt.receipt_id !== binding.receipt_id
    || receipt.request_id !== input.request_id || receipt.command_digest !== record.control_command_digest
    || receipt.decision !== "approve" || receipt.signer_principal_id !== "principal:owner"
    || binding.principal_id !== "principal:owner" || !Number.isFinite(redeemed.getTime())
    || !Number.isFinite(dispatched.getTime()) || dispatched < redeemed
    || !Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(input.expires_at))
    || Date.parse(record.created_at) < redeemed.getTime()
    || Date.parse(input.expires_at) <= dispatched.getTime()
    || !verifyCommandApproval(receipt,binding.public_key_pem,redeemed)
    || !verifyCommandApproval(receipt,binding.public_key_pem,dispatched)) invalidCorrectionControl();
  return { input, fence, receipt_id: binding.receipt_id, redeemed_at: binding.redeemed_at };
}
