import { JarvisError } from "./db.js";
import { MemoryOutboxLedger } from "./memory-outbox-ledger.js";
import { memoryInvocation } from "./memory-outbox-values.js";
import { readCurrentMemoryScopedOutbox } from "./memory-scoped-outbox-reader.js";

type Options = Parameters<typeof readCurrentMemoryScopedOutbox>[0];
export type MemoryScopedOutboxLease = Readonly<{ outbox_id: string; worker: string; fence: number; lease_expires_at: string }>;
function currentOptions(options: Options): Options {
  let previous = Number.NEGATIVE_INFINITY;
  let policyExpiry = Number.POSITIVE_INFINITY;
  return { ...options, resolveWriteScope: at => {
    const scope = options.resolveWriteScope(at);
    if (scope !== undefined) policyExpiry = Math.min(policyExpiry, Date.parse(scope.valid_until));
    return scope;
  }, clock: () => {
    const at = options.clock().getTime();
    if (!Number.isFinite(at) || at < previous) throw new JarvisError("SCOPED_OUTBOX_TIME_INVALID");
    if (!(at < policyExpiry)) throw new JarvisError("SCOPED_OUTBOX_POLICY_EXPIRED");
    previous = at; return new Date(at);
  } };
}
function duration(ms: number) {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 900000) throw new JarvisError("SCOPED_OUTBOX_LEASE_INVALID");
}
function requireLease(options: Options, lease: MemoryScopedOutboxLease, now: Date) {
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1 || options.authority.db.prepare(`SELECT 1 FROM memory_outbox
    WHERE outbox_id=? AND request_profile='scoped-v4' AND state='claimed' AND lease_owner=? AND lease_fence=?
    AND lease_expires_at=? AND lease_expires_at>?`).get(lease.outbox_id, lease.worker, lease.fence,
    lease.lease_expires_at, now.toISOString()) === undefined) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
}

/** Claim a specific registration using the existing outbox; no second queue.
 * Policy failure leaves it unchanged so a different session cannot poison it. */
export function claimMemoryScopedOutbox(input: Options, outboxId: string, worker: string, leaseMs: number) {
  duration(leaseMs);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(worker)) throw new JarvisError("SCOPED_OUTBOX_LEASE_INVALID");
  const options = currentOptions(input), db = options.authority.db;
  return db.transaction(() => {
    const now = options.clock().toISOString();
    const row = db.prepare(`SELECT state,lease_fence,action_request_id FROM memory_outbox WHERE outbox_id=?
      AND request_profile='scoped-v4' AND (state='queued' OR (state='claimed' AND lease_expires_at<=?))`)
      .get(outboxId, now) as { state: string; lease_fence: number; action_request_id: string } | undefined;
    if (row === undefined) return undefined;
    const request = readCurrentMemoryScopedOutbox(options, outboxId);
    const at = options.clock();
    if (Date.parse(request.expires_at) <= at.getTime()) throw new JarvisError("SCOPED_OUTBOX_LEASE_INVALID");
    const fence = row.lease_fence + 1;
    if (!Number.isSafeInteger(fence)) throw new JarvisError("SCOPED_OUTBOX_LEASE_INVALID");
    const until = new Date(Math.min(at.getTime() + leaseMs, Date.parse(request.expires_at))).toISOString();
    const changed = db.prepare(`UPDATE memory_outbox SET state='claimed',lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
      WHERE outbox_id=? AND request_profile='scoped-v4' AND lease_fence=?
      AND (state='queued' OR (state='claimed' AND lease_expires_at<=?))`).run(worker, fence, until, at.toISOString(), outboxId,
      row.lease_fence, at.toISOString()).changes;
    if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    new MemoryOutboxLedger(options.authority).audit(outboxId, "claimed", row.state, "claimed", fence, row.action_request_id, null, at.toISOString());
    return Object.freeze({ outbox_id: outboxId, worker, fence, lease_expires_at: until });
  }).immediate();
}

/** Commit one dispatch attempt before any external call. A lost return must be
 * reconciled from the attempt; it must never be replayed as permission to send. */
export function markMemoryScopedOutboxDispatch(input: Options, lease: MemoryScopedOutboxLease, deadlineMs: number) {
  duration(deadlineMs);
  const options = currentOptions(input), db = options.authority.db;
  return db.transaction(() => {
    requireLease(options, lease, options.clock());
    const request = readCurrentMemoryScopedOutbox(options, lease.outbox_id);
    const at = options.clock();
    requireLease(options, lease, at);
    if (Date.parse(request.expires_at) <= at.getTime()) throw new JarvisError("SCOPED_OUTBOX_LEASE_INVALID");
    const invocation = memoryInvocation(lease.outbox_id, request.request_digest, lease.fence);
    const instant = at.toISOString();
    const changed = db.prepare(`UPDATE memory_outbox SET state='dispatching',dispatch_fence=?,dispatched_at=?,
      reconcile_deadline_at=?,updated_at=? WHERE outbox_id=? AND request_profile='scoped-v4' AND state='claimed'
      AND lease_owner=? AND lease_fence=? AND lease_expires_at>?`).run(lease.fence, instant,
      new Date(at.getTime() + deadlineMs).toISOString(), instant, lease.outbox_id, lease.worker, lease.fence, instant).changes;
    if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    db.prepare(`INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,dispatch_fence,invocation_digest,request_digest,
      outcome,dispatched_at,created_at,updated_at) VALUES(?,?,?,?,?,'dispatching',?,?,?)`).run(invocation.attempt_id,
      lease.outbox_id, lease.fence, invocation.digest, request.request_digest, instant, instant, instant);
    const ledger = new MemoryOutboxLedger(options.authority);
    ledger.event(lease.outbox_id, lease.fence, "dispatch_authority_spent", null, instant, invocation.attempt_id);
    ledger.audit(lease.outbox_id, "dispatching", "claimed", "dispatching", lease.fence, request.request_id, invocation.digest, instant);
    return Object.freeze({ request, outbox_id: lease.outbox_id, fence: lease.fence,
      attempt_id: invocation.attempt_id, invocation_digest: invocation.digest });
  }).immediate();
}

/** Historical recovery only. An expired dispatch lease is an unknown outcome,
 * never permission to send again, even when policy or source authority expired. */
export function recoverMemoryScopedOutboxDispatches(authority: Options["authority"], now: Date): number {
  if (!Number.isFinite(now.getTime())) throw new JarvisError("SCOPED_OUTBOX_TIME_INVALID");
  const at = now.toISOString(), db = authority.db;
  return db.transaction(() => {
    const rows = db.prepare(`SELECT outbox_id,lease_fence FROM memory_outbox WHERE request_profile='scoped-v4'
      AND state='dispatching' AND lease_expires_at<=? ORDER BY outbox_id`).all(at) as Array<{ outbox_id: string; lease_fence: number }>;
    const ledger = new MemoryOutboxLedger(authority);
    for (const row of rows) {
      db.prepare(`UPDATE memory_outbox SET state='reconciling',lease_owner=NULL,lease_expires_at=NULL,
        failure_code='DISPATCH_OUTCOME_UNKNOWN',updated_at=? WHERE outbox_id=? AND request_profile='scoped-v4'
        AND state='dispatching' AND lease_expires_at<=?`).run(at, row.outbox_id, at);
      ledger.event(row.outbox_id, row.lease_fence, "dispatch_uncertain", "DISPATCH_OUTCOME_UNKNOWN", at);
    }
    return rows.length;
  }).immediate();
}
