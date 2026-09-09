import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { MemoryOutboxLedger } from "./memory-outbox-ledger.js";
import { memoryInvocation } from "./memory-outbox-values.js";
import { MemoryScopedWriteSpool } from "./memory-scoped-write-spool.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

export type MemoryScopedReconcileOptions = {
  readonly authority: AuthorityDb; readonly spoolRoot: string; readonly providerInstanceId: string;
};
export type MemoryScopedReconcileLease = Readonly<{
  outbox_id: string; worker: string; fence: number; dispatch_fence: number; lease_expires_at: string;
}>;
const fail = (): never => { throw new JarvisError("SCOPED_RECONCILIATION_INVALID"); };
function instant(now: Date) {
  if (!Number.isFinite(now.getTime())) return fail();
  return now.toISOString();
}
/** Historical worker material for one already-spent or settled attempt. The historical decode
 * does not renew write authority or authorize a provider read. The consumer must
 * obtain current read claims independently. No global enumeration or resend. */
export function readMemoryScopedReconciliationRequest(options: MemoryScopedReconcileOptions, outboxId: string, now: Date) {
  const at = instant(now), db = options.authority.db;
  return db.transaction(() => {
    const row = db.prepare(`SELECT o.*,b.provider_instance_id,b.scope_digest,b.scope_review_request_id,
      b.scope_review_receipt_id,b.scope_command_digest,b.source_request_id,b.source_request_digest,
      a.attempt_id,a.invocation_digest,a.dispatched_at AS attempt_dispatched_at,a.outcome
      FROM memory_outbox o JOIN memory_scoped_outbox_bindings b ON b.outbox_id=o.outbox_id
      AND b.candidate_id=o.candidate_id AND b.request_id=o.request_id AND b.request_digest=o.request_digest
      AND b.idempotency_key=o.idempotency_key AND b.created_at=o.created_at
      JOIN memory_outbox_attempts a ON a.outbox_id=o.outbox_id AND a.dispatch_fence=o.dispatch_fence
      AND a.request_digest=o.request_digest
      WHERE o.outbox_id=? AND o.request_profile='scoped-v4' AND o.state IN ('reconciling','settled')`).get(outboxId) as Record<string, unknown> | undefined;
    if (row === undefined || row.provider_instance_id !== options.providerInstanceId
      || !["dispatching", "uncertain", "accepted"].includes(String(row.outcome))
      || !Number.isSafeInteger(row.dispatch_fence) || Number(row.dispatch_fence) < 1
      || typeof row.dispatched_at !== "string" || row.attempt_dispatched_at !== row.dispatched_at
      || typeof row.updated_at !== "string" || row.updated_at > at) return fail();
    const visibility = new MemoryProjectionAuthority(options.authority);
    if (visibility.isProjectionIdSuppressed(outboxId)
      || visibility.isProjectionIdSuppressed(String(row.candidate_id))) return fail();
    const dispatched = new Date(row.dispatched_at), updated = new Date(row.updated_at);
    if (!Number.isFinite(dispatched.getTime()) || dispatched.toISOString() !== row.dispatched_at || dispatched > now
      || !Number.isFinite(updated.getTime()) || updated.toISOString() !== row.updated_at || updated < dispatched || updated > now) return fail();
    const request = new MemoryScopedWriteSpool(options.spoolRoot, options.providerInstanceId)
      .read(String(row.idempotency_key), dispatched);
    const source = request.source_request, binding = request.preparation.binding;
    const invocation = memoryInvocation(outboxId, request.request_digest, Number(row.dispatch_fence));
    const expected = { page_id: row.expected_page_id, sid: row.expected_sid, source_digest: row.expected_artifact_digest };
    if (row.request_id !== request.request_id || row.request_digest !== request.request_digest
      || row.idempotency_key !== request.idempotency_key || row.candidate_id !== source.candidate_id
      || row.candidate_digest !== source.candidate_digest || row.classification_digest !== source.classification_digest
      || row.source_request_id !== source.request_id || row.source_request_digest !== source.request_digest
      || row.operation !== source.operation || row.expires_at !== request.expires_at
      || row.scope_digest !== binding.identity_digest || row.scope_review_request_id !== binding.control_request_id
      || row.scope_review_receipt_id !== binding.control_receipt_id || row.scope_command_digest !== binding.command_digest
      || row.attempt_id !== invocation.attempt_id || row.invocation_digest !== invocation.digest
      || outboxId !== `memout:scoped:v4:${memoryHash("orca-jarvis/memory-scoped-outbox/v4\0", {
        request_id: request.request_id, request_digest: request.request_digest, expected_artifact: expected }).slice(7)}`) return fail();
    return request;
  }).immediate();
}

/** Local serialization of reconciliation only; dispatch_fence is never changed. */
export function claimMemoryScopedReconciliation(options: MemoryScopedReconcileOptions, outboxId: string,
  worker: string, now: Date, leaseMs: number) {
  const at = instant(now), db = options.authority.db;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(worker)
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 900000) return fail();
  return db.transaction(() => {
    const row = db.prepare(`SELECT lease_fence,dispatch_fence FROM memory_outbox WHERE outbox_id=?
      AND request_profile='scoped-v4' AND state='reconciling' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .get(outboxId, at) as { lease_fence: number; dispatch_fence: number } | undefined;
    if (row === undefined) return undefined;
    const request = readMemoryScopedReconciliationRequest(options, outboxId, now);
    const fence = row.lease_fence + 1;
    if (!Number.isSafeInteger(fence) || fence < 1) return fail();
    const until = new Date(now.getTime() + leaseMs).toISOString();
    const changed = db.prepare(`UPDATE memory_outbox SET lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
      WHERE outbox_id=? AND request_profile='scoped-v4' AND state='reconciling' AND lease_fence=?
      AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(worker, fence, until, at, outboxId, row.lease_fence, at).changes;
    if (changed !== 1) return fail();
    new MemoryOutboxLedger(options.authority).audit(outboxId, "reconcile_claimed", "reconciling", "reconciling", fence,
      request.request_id, null, at);
    const lease: MemoryScopedReconcileLease = Object.freeze({ outbox_id: outboxId, worker, fence,
      dispatch_fence: row.dispatch_fence, lease_expires_at: until });
    return Object.freeze({ lease, request });
  }).immediate();
}

export function requireMemoryScopedReconciliationLease(authority: AuthorityDb, lease: MemoryScopedReconcileLease, now: Date): void {
  const at = instant(now);
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1 || !Number.isSafeInteger(lease.dispatch_fence) || lease.dispatch_fence < 1
    || authority.db.prepare(`SELECT 1 FROM memory_outbox WHERE outbox_id=? AND request_profile='scoped-v4'
      AND state='reconciling' AND lease_owner=? AND lease_fence=? AND dispatch_fence=? AND lease_expires_at=?
      AND lease_expires_at>? AND updated_at<=?`).get(lease.outbox_id, lease.worker, lease.fence, lease.dispatch_fence,
      lease.lease_expires_at, at, at) === undefined) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
}

export function releaseMemoryScopedReconciliation(authority: AuthorityDb, lease: MemoryScopedReconcileLease, now: Date): void {
  authority.db.transaction(() => {
    requireMemoryScopedReconciliationLease(authority, lease, now);
    authority.db.prepare(`UPDATE memory_outbox SET lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE outbox_id=?`)
      .run(instant(now), lease.outbox_id);
    new MemoryOutboxLedger(authority).audit(lease.outbox_id, "reconcile_released", "reconciling", "reconciling", lease.fence,
      lease.outbox_id, null, instant(now));
  }).immediate();
}
