import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { ControlPlane, verifyCommandApproval } from "./control-plane.js";
import { controlValueDigest as hash } from "./control-plane-contract.js";
import type { CommandApprovalReceipt } from "./control-plane-contract.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { verifyMemoryDispositionProof } from "./memory-disposition-proof.js";
import type { MemoryDeletionRecord } from "./memory-deletion-store.js";

const bindingSchema = z.object({
  state: z.string(), lease_fence: z.number().int(), command_digest: z.string(),
  control_command_digest: z.string(), receipt_id: z.string(), redeemed_at: z.string(),
  dispatched_at: z.string(), payload_json: z.string(), signature: z.string(), public_key_pem: z.string(),
  principal_id: z.literal("principal:owner"), proof_json: z.string(), verified_at: z.string(),
});

/** Project a proven deletion on its spent fence; this does not issue fresh write authority. */
export function reconcileDeletionControl(authority: AuthorityDb, record: MemoryDeletionRecord, now: Date): void {
  const binding = bindingSchema.safeParse(authority.db.prepare(
    `SELECT r.state,r.lease_fence,r.command_digest,d.control_command_digest,d.dispatched_at,
      x.receipt_id,x.redeemed_at,a.payload_json,a.signature,k.public_key_pem,k.principal_id,q.proof_json,q.verified_at
     FROM memory_deletion_effect_requests d JOIN control_command_requests r ON r.request_id=d.control_request_id
     JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
     JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
     JOIN memory_deletion_proofs q ON q.deletion_id=d.deletion_id AND q.proof_digest=d.provider_proof_digest
     JOIN trusted_authority_keys k ON k.key_id=a.key_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE d.deletion_id=? AND d.state='settled'`,
  ).get(record.deletion_id));
  if (!binding.success || record.control_request_id === null || record.provider_proof_digest === null
    || record.purge_receipt_digest === null) throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
  const row = binding.data;
  if (row.state === "completed") return;
  if (row.state !== "claimed" && row.state !== "uncertain") throw new JarvisError("CONTROL_STALE_FENCE");
  if (authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
    .get(record.control_request_id, record.control_receipt_id)
    || authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?)")
      .get(record.control_request_id, row.command_digest, record.control_receipt_id)) return;
  // The receipt parser belongs to the existing control-plane signature boundary.
  const receipt: CommandApprovalReceipt = JSON.parse(row.payload_json);
  if (row.receipt_id !== record.control_receipt_id || row.command_digest !== row.control_command_digest
    || receipt.request_id !== record.control_request_id || receipt.command_digest !== row.command_digest
    || receipt.signature !== row.signature || receipt.receipt_id !== row.receipt_id
    || receipt.decision !== "approve" || receipt.signer_principal_id !== row.principal_id
    || !verifyCommandApproval(receipt, row.public_key_pem, new Date(row.redeemed_at))
    || !verifyCommandApproval(receipt, row.public_key_pem, new Date(row.dispatched_at))) {
    throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
  }
  const identity = z.object({ provider_instance_id: z.string(), request_id: z.string(),
    request_digest: z.string(), envelope_digest: z.string(), provider_idempotency_key: z.string(),
    delegation_id: z.string(), delegation_digest: z.string(), lane_id: z.string(), payload_digest: z.string(),
    target_manifest_digest: z.string(), scope_digest: z.string(), tombstone_sequence: z.number().int(),
    tombstone_set_root: z.string() }).parse(record);
  const proof = verifyMemoryDispositionProof(authority, JSON.parse(row.proof_json),
    { ...identity, idempotency_key: identity.provider_idempotency_key, operation: "forget" }, new Date(row.verified_at));
  if (proof.proof_digest !== record.provider_proof_digest) throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
  const payload = { deletion_id: record.deletion_id, proof_digest: record.provider_proof_digest,
    purge_receipt_digest: record.purge_receipt_digest };
  const requestId = record.control_request_id;
  const effectId = `effect:${hash({ requestId, fence: row.lease_fence, outcome: "completed", payload }).slice(7)}`;
  const encoded = canonicalize(payload);
  authority.db.prepare("INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)")
    .run(effectId, requestId, "memory.deletion.settled", encoded, hash(encoded), now.toISOString());
  const changed = authority.db.prepare(`UPDATE control_command_requests SET state='completed',completed_at=?,
    failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state=? AND lease_fence=?`)
    .run(now.toISOString(), requestId, row.state, row.lease_fence);
  if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
  new ControlPlane(authority).emit({ event_id: `evt:${requestId}:completed:${row.lease_fence}`,
    event_type: "control.command.completed", source: "jarvis-memory-deletion", subject: requestId,
    correlation_id: requestId, causation_id: `evt:${requestId}:claimed:${row.lease_fence}`,
    payload: { effect_id: effectId, failure_code: null }, created_at: now.toISOString() });
}

const refusalBinding = z.object({
  state: z.string(), lease_fence: z.number().int(), command_digest: z.string(),
  control_command_digest: z.string(), dispatched_at: z.string(),
  receipt_id: z.string(), redeemed_at: z.string(), payload_json: z.string(), signature: z.string(),
  public_key_pem: z.string(), principal_id: z.literal("principal:owner"),
});

/**
 * Settles the control as failed for a deletion the provider refused before any effect. There is
 * no proof and no purge to bind, so the payload carries identity and the refusal code only.
 * A second call finds the control already failed and writes nothing.
 */
export function refuseDeletionControl(authority: AuthorityDb, record: MemoryDeletionRecord,
  failureCode: string, now: Date): boolean {
  return authority.db.transaction(() => {
    if (record.control_request_id === null || record.lane_id === null) {
      throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
    }
    const binding = refusalBinding.safeParse(authority.db.prepare(
      `SELECT r.state,r.lease_fence,r.command_digest,d.control_command_digest,d.dispatched_at,
        x.receipt_id,x.redeemed_at,a.payload_json,a.signature,k.public_key_pem,k.principal_id
       FROM memory_deletion_effect_requests d JOIN control_command_requests r ON r.request_id=d.control_request_id
       JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
       JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
       JOIN trusted_authority_keys k ON k.key_id=a.key_id
       JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
       WHERE d.deletion_id=? AND d.state='conflict'`,
    ).get(record.deletion_id));
    if (!binding.success) throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
    const row = binding.data;
    if (row.state === "failed") return false;
    if (row.state !== "claimed" && row.state !== "uncertain") throw new JarvisError("CONTROL_STALE_FENCE");
    if (authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
      .get(record.control_request_id, record.control_receipt_id)
      || authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?)")
        .get(record.control_request_id, row.command_digest, record.control_receipt_id)) return false;
    const receipt: CommandApprovalReceipt = JSON.parse(row.payload_json);
    if (row.receipt_id !== record.control_receipt_id || row.command_digest !== row.control_command_digest
      || receipt.request_id !== record.control_request_id || receipt.command_digest !== row.command_digest
      || receipt.signature !== row.signature || receipt.receipt_id !== row.receipt_id
      || receipt.decision !== "approve" || receipt.signer_principal_id !== row.principal_id
      || !verifyCommandApproval(receipt, row.public_key_pem, new Date(row.redeemed_at))
      || !verifyCommandApproval(receipt, row.public_key_pem, new Date(row.dispatched_at))) {
      throw new JarvisError("MEMORY_DELETION_CONTROL_EVIDENCE_INVALID");
    }
    const payload = { schema_version: 1, deletion_id: record.deletion_id, lane_id: record.lane_id,
      request_digest: record.request_digest, failure_code: failureCode, refused_at: now.toISOString() };
    const requestId = record.control_request_id;
    const effectId = `effect:${hash({ requestId, fence: row.lease_fence, outcome: "failed", payload }).slice(7)}`;
    const encoded = canonicalize(payload);
    authority.db.prepare(
      "INSERT OR IGNORE INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)",
    ).run(effectId, requestId, "memory.deletion.refused", encoded, hash(encoded), now.toISOString());
    const changed = authority.db.prepare(`UPDATE control_command_requests SET state='failed',completed_at=?,
      failure_code=?,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state=? AND lease_fence=?`)
      .run(now.toISOString(), failureCode, requestId, row.state, row.lease_fence);
    if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
    authority.db.prepare(
      "UPDATE memory_effect_preparations SET state='consumed',updated_at=? WHERE lane_id=? AND state='approved'",
    ).run(now.toISOString(), record.lane_id);
    new ControlPlane(authority).emit({ event_id: `evt:${requestId}:failed:${row.lease_fence}`,
      event_type: "control.command.failed", source: "jarvis-memory-deletion", subject: requestId,
      correlation_id: requestId, causation_id: `evt:${requestId}:claimed:${row.lease_fence}`,
      payload: { effect_id: effectId, failure_code: failureCode }, created_at: now.toISOString() });
    return true;
  }).immediate();
}
