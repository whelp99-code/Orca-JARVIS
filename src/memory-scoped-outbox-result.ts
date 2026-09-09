import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { MemoryOutboxLedger } from "./memory-outbox-ledger.js";
import { memoryInvocation, memoryOutboxHash } from "./memory-outbox-values.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";

/** Persist an acceptance for the original spent attempt, including a late reply
 * after crash recovery. Never settles memory or grants another dispatch. */
export function recordMemoryScopedOutboxAcceptance(authority: AuthorityDb, outboxId: string, fence: number,
  request: MemoryScopedWriteRequestMaterial, value: unknown, observedAt: Date) {
  const accepted = parseSecondBrainScopedWriteAccepted(value, request, observedAt);
  const normalized = { ...accepted, replayed: false };
  const raw = canonicalize(normalized), receipt = memoryOutboxHash("memory-outbox-acceptance", normalized);
  const at = observedAt.toISOString(), db = authority.db;
  const fail = (): never => { throw new JarvisError("SCOPED_OUTBOX_ACCEPTANCE_CONFLICT"); };
  return db.transaction(() => {
    const row = db.prepare(`SELECT o.state,o.dispatch_fence,o.request_id,o.request_digest,o.idempotency_key,
      b.provider_instance_id,b.scope_digest,a.attempt_id,a.invocation_digest,a.dispatched_at,a.outcome,
      a.accepted_result_json,a.acceptance_receipt_digest FROM memory_outbox o
      JOIN memory_scoped_outbox_bindings b ON b.outbox_id=o.outbox_id AND b.request_id=o.request_id
      AND b.request_digest=o.request_digest AND b.idempotency_key=o.idempotency_key
      JOIN memory_outbox_attempts a ON a.outbox_id=o.outbox_id AND a.dispatch_fence=o.dispatch_fence
      AND a.request_digest=o.request_digest WHERE o.outbox_id=? AND o.request_profile='scoped-v4'`)
      .get(outboxId) as Record<string, unknown> | undefined;
    if (row === undefined || !Number.isSafeInteger(fence) || fence < 1 || row.dispatch_fence !== fence
      || row.request_id !== accepted.request_id || row.request_digest !== accepted.request_digest
      || row.idempotency_key !== accepted.idempotency_key || row.provider_instance_id !== accepted.provider_instance_id
      || row.scope_digest !== accepted.scope_digest || (row.state !== "dispatching" && row.state !== "reconciling")
      || typeof row.dispatched_at !== "string" || Date.parse(row.dispatched_at) > Date.parse(accepted.accepted_at)) return fail();
    const invocation = memoryInvocation(outboxId, accepted.request_digest, fence);
    if (row.attempt_id !== invocation.attempt_id || row.invocation_digest !== invocation.digest) return fail();
    const replayed = row.outcome === "accepted";
    if (replayed) {
      if (row.accepted_result_json !== raw || row.acceptance_receipt_digest !== receipt) return fail();
    } else {
      if (row.outcome !== "dispatching" && row.outcome !== "uncertain") return fail();
      db.prepare(`UPDATE memory_outbox_attempts SET outcome='accepted',outcome_code='PROVIDER_ACCEPTED',
        accepted_result_json=?,acceptance_receipt_digest=?,completed_at=?,updated_at=? WHERE attempt_id=?`)
        .run(raw, receipt, at, at, invocation.attempt_id);
      new MemoryOutboxLedger(authority).event(outboxId, fence, "provider_accepted", null, at, invocation.attempt_id, receipt);
    }
    if (row.state === "dispatching") {
      db.prepare(`UPDATE memory_outbox SET state='reconciling',lease_owner=NULL,lease_expires_at=NULL,
        failure_code=NULL,updated_at=? WHERE outbox_id=? AND state='dispatching' AND dispatch_fence=?`).run(at, outboxId, fence);
      new MemoryOutboxLedger(authority).audit(outboxId, "reconciling", "dispatching", "reconciling", fence,
        accepted.request_id, receipt, at);
    } else {
      // A verified late acknowledgement resolves the unknown dispatch outcome,
      // but does not settle the stored memory or erase unrelated failure reasons.
      db.prepare(`UPDATE memory_outbox SET failure_code=NULL,updated_at=? WHERE outbox_id=?
        AND request_profile='scoped-v4' AND state='reconciling' AND dispatch_fence=?
        AND failure_code='DISPATCH_OUTCOME_UNKNOWN'`).run(at, outboxId, fence);
    }
    return Object.freeze({ kind: "acceptance_recorded" as const, outbox_id: outboxId,
      attempt_id: invocation.attempt_id, acceptance_receipt_digest: receipt, replayed });
  }).immediate();
}
