import { canonicalize } from "./canonical.js";
import { controlValueDigest } from "./control-plane-contract.js";
import { ControlPlane } from "./control-plane.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { MemoryOutboxLedger } from "./memory-outbox-ledger.js";
import { memoryInvocation, type MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import type { createMemoryScopedClient } from "./memory-scoped-client.js";
import { recordMemoryScopedCompletionObservation } from "./memory-scoped-completion-observation.js";
import { readMemoryScopedCompletionProof } from "./memory-scoped-completion-proof.js";
import { readMemoryScopedReconciliationRequest, requireMemoryScopedReconciliationLease,
  type MemoryScopedReconcileLease, type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";
import { readMemoryScopedSettlementAuthority } from "./memory-scoped-settlement-authority.js";

const fail = (): never => { throw new JarvisError("SCOPED_SETTLEMENT_INVALID"); };
const receiptHash = (value: unknown) => memoryHash("orca-jarvis/memory-scoped-settlement/v1\0", value);

/** Historical result only, never renewed authority or a repeated effect. */
export function readMemoryScopedSettlement(options: MemoryScopedReconcileOptions, outboxId: string, now: Date) {
  return options.authority.db.transaction(() => {
    const db = options.authority.db;
    const row = db.prepare(`SELECT s.*,o.state,o.settlement_receipt_digest,o.settled_at AS outbox_settled,
      r.state AS control_state,r.lease_fence AS current_control_fence,r.completed_at
      FROM memory_scoped_settlements s JOIN memory_outbox o ON o.outbox_id=s.outbox_id
      JOIN control_command_requests r ON r.request_id=s.control_request_id WHERE s.outbox_id=?`)
      .get(outboxId) as Record<string, any> | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.receipt_json);
    const proof = readMemoryScopedCompletionProof(options, row.observation_id, now);
    const settled = new Date(row.settled_at);
    if (!Number.isFinite(settled.getTime()) || settled.toISOString() !== row.settled_at
      || settled.getTime() < Date.parse(proof.observed_at)
      || Object.keys(value).sort().join(" ") !== "authority evidence_digest observation_id outbox_id reconcile_fence schema_version settled_at"
      || value.schema_version !== 1 || canonicalize(value) !== row.receipt_json || receiptHash(value) !== row.receipt_digest
      || value.outbox_id !== outboxId || value.observation_id !== row.observation_id
      || value.evidence_digest !== proof.evidence_digest || value.reconcile_fence !== row.reconcile_fence
      || value.authority.control_request_id !== row.control_request_id || value.authority.control_fence !== row.control_fence
      || row.state !== "settled" || row.control_state !== "completed" || row.current_control_fence !== row.control_fence
      || row.settlement_receipt_digest !== row.receipt_digest || row.outbox_settled !== row.settled_at
      || row.completed_at !== row.settled_at || value.settled_at !== row.settled_at
      || !Number.isFinite(now.getTime()) || Date.parse(row.settled_at) > now.getTime()) return fail();
    const effect = db.prepare("SELECT request_id,effect_type,payload_json,payload_digest FROM control_command_effects WHERE effect_id=?")
      .get("effect:memory-scoped:" + row.receipt_digest.slice(7)) as Record<string, string> | undefined;
    const payload = { outbox_id: outboxId, receipt_digest: row.receipt_digest, observation_id: row.observation_id };
    if (effect === undefined || effect.request_id !== row.control_request_id || effect.effect_type !== "memory.scoped.settled"
      || effect.payload_json !== canonicalize(payload) || effect.payload_digest !== controlValueDigest(effect.payload_json)) return fail();
    const eventId = "evt:" + row.control_request_id + ":completed:" + row.control_fence;
    const event = db.prepare("SELECT * FROM control_events WHERE event_id=?").get(eventId) as Record<string, any> | undefined;
    const eventPayload = canonicalize({ effect_id: "effect:memory-scoped:" + row.receipt_digest.slice(7), failure_code: null });
    if (event === undefined || event.event_type !== "control.command.completed" || event.source !== "jarvis-memory-scoped"
      || event.subject !== row.control_request_id || event.causation_id !== row.observation_id
      || event.created_at !== row.settled_at || event.payload_json !== eventPayload
      || event.payload_digest !== controlValueDigest(eventPayload)) return fail();
    return Object.freeze({ kind: "memory_scoped_settled" as const, outbox_id: outboxId,
      receipt_digest: row.receipt_digest as string, control_request_id: row.control_request_id as string,
      settled_at: row.settled_at as string, replayed: true });
  }).immediate();
}

export async function settleMemoryScopedCompletion(options: MemoryScopedReconcileOptions,
  lease: MemoryScopedReconcileLease, client: Pick<ReturnType<typeof createMemoryScopedClient>, "withRememberedCompletion">,
  now: () => Date, roots: MemoryOutboxSpoolRoots = {}, signal?: AbortSignal) {
  if (signal?.aborted) throw new JarvisError("SECOND_BRAIN_CANCELLED");
  const replay = readMemoryScopedSettlement(options, lease.outbox_id, now());
  if (replay !== undefined) return replay;
  const request = readMemoryScopedReconciliationRequest(options, lease.outbox_id, now());
  return client.withRememberedCompletion(request, (observation, refresh) => options.authority.db.transaction(() => {
    const db = options.authority.db;
    const recorded = recordMemoryScopedCompletionObservation(options, lease, request, observation, refresh, now);
    const proof = readMemoryScopedCompletionProof(options, recorded.observation_id, now());
    const live = refresh(), at = new Date(now().getTime());
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(live.checked_at)
      || !(at.getTime() < Date.parse(live.valid_until))) return fail();
    requireMemoryScopedReconciliationLease(options.authority, lease, at);
    const authority = readMemoryScopedSettlementAuthority(options, lease.outbox_id, at, roots);
    const row = db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(lease.outbox_id) as Record<string, any>;
    const value = { schema_version: 1, outbox_id: lease.outbox_id, observation_id: recorded.observation_id,
      evidence_digest: proof.evidence_digest, reconcile_fence: lease.fence, authority, settled_at: at.toISOString() };
    const receipt = receiptHash(value), ledger = new MemoryOutboxLedger(options.authority);
    db.prepare(`INSERT INTO memory_scoped_settlements(outbox_id,observation_id,receipt_digest,receipt_json,
      control_request_id,control_fence,reconcile_fence,settled_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(lease.outbox_id, recorded.observation_id, receipt, canonicalize(value), authority.control_request_id,
        authority.control_fence, lease.fence, at.toISOString());
    const artifact = { kind: "match" as const, code: "ARTIFACT_OBSERVED", page_id: row.expected_page_id,
      sid: row.expected_sid, source_digest: row.expected_artifact_digest,
      source_version: proof.evidence.artifact.generation.generation_id };
    const attempt = memoryInvocation(lease.outbox_id, request.request_digest, lease.dispatch_fence).attempt_id;
    ledger.event(lease.outbox_id, lease.fence, "artifact_observed", artifact.code, at.toISOString(), attempt, undefined, artifact, true);
    ledger.event(lease.outbox_id, lease.fence, "settled", artifact.code, at.toISOString(), attempt, receipt, artifact, true);
    // No asynchronous work after this final current-authorization boundary.
    const final = refresh(), last = new Date(now().getTime());
    if (last < at || last.getTime() < Date.parse(final.checked_at) || !(last.getTime() < Date.parse(final.valid_until))) return fail();
    requireMemoryScopedReconciliationLease(options.authority, lease, last);
    readMemoryScopedSettlementAuthority(options, lease.outbox_id, last, roots);
    const changed = db.prepare(`UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,
      failure_code=NULL,settlement_receipt_digest=?,settled_at=?,updated_at=? WHERE outbox_id=? AND state='reconciling' AND lease_fence=?`)
      .run(receipt, at.toISOString(), at.toISOString(), lease.outbox_id, lease.fence).changes;
    if (changed !== 1) return fail();
    const payload = { outbox_id: lease.outbox_id, receipt_digest: receipt, observation_id: recorded.observation_id };
    const raw = canonicalize(payload), effectId = "effect:memory-scoped:" + receipt.slice(7);
    db.prepare(`INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at)
      VALUES(?,?,?,?,?,?)`).run(effectId, authority.control_request_id, "memory.scoped.settled", raw, controlValueDigest(raw), at.toISOString());
    if (db.prepare(`UPDATE control_command_requests SET state='completed',completed_at=?,failure_code=NULL,
      lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state IN ('claimed','uncertain') AND lease_fence=?`)
      .run(at.toISOString(), authority.control_request_id, authority.control_fence).changes !== 1) return fail();
    new ControlPlane(options.authority).emit({ event_id: `evt:${authority.control_request_id}:completed:${authority.control_fence}`,
      event_type: "control.command.completed", source: "jarvis-memory-scoped", subject: authority.control_request_id,
      correlation_id: authority.control_request_id, causation_id: recorded.observation_id,
      payload: { effect_id: effectId, failure_code: null }, created_at: at.toISOString() });
    ledger.audit(lease.outbox_id, "settled", "reconciling", "settled", lease.fence, request.request_id, receipt, at.toISOString());
    return Object.freeze({ ...readMemoryScopedSettlement(options, lease.outbox_id, at)!, replayed: false });
  }).immediate(), signal);
}
