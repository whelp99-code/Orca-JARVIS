import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryInvocation } from "./memory-outbox-values.js";

/** Read the original spent attempt, not a new dispatch lease. Caller retains its
 * authority transaction across all dependent policy/source checks. */
export function readMemoryScopedDispatchBinding(authority: AuthorityDb, outboxId: string, fence: number, now: Date) {
  const fail = (): never => { throw new JarvisError("SCOPED_DISPATCH_AUTHORITY_INVALID"); };
  if (!Number.isSafeInteger(fence) || fence < 1 || !Number.isFinite(now.getTime())) return fail();
  const row = authority.db.prepare(`SELECT o.request_id,o.request_digest,o.candidate_id,o.dispatched_at,
    o.expires_at,a.attempt_id,a.invocation_digest,a.dispatched_at AS attempt_dispatched_at,
    b.source_request_id,b.source_request_digest
    FROM memory_outbox o JOIN memory_scoped_outbox_bindings b ON b.outbox_id=o.outbox_id
      AND b.candidate_id=o.candidate_id AND b.request_id=o.request_id AND b.request_digest=o.request_digest
      AND b.idempotency_key=o.idempotency_key
    JOIN memory_outbox_attempts a ON a.outbox_id=o.outbox_id AND a.dispatch_fence=o.dispatch_fence
      AND a.request_digest=o.request_digest
    WHERE o.outbox_id=? AND o.request_profile='scoped-v4' AND o.state IN ('dispatching','reconciling')
      AND o.dispatch_fence=? AND a.outcome IN ('dispatching','uncertain','accepted')`).get(outboxId, fence) as
      { request_id: string; request_digest: string; candidate_id: string; dispatched_at: string; expires_at: string;
        attempt_id: string; invocation_digest: string; attempt_dispatched_at: string;
        source_request_id: string; source_request_digest: string } | undefined;
  if (row === undefined) return fail();
  const invocation = memoryInvocation(outboxId, row.request_digest, fence);
  const sent = Date.parse(row.dispatched_at), expires = Date.parse(row.expires_at);
  if (!Number.isFinite(sent) || new Date(sent).toISOString() !== row.dispatched_at || sent > now.getTime()
    || !(now.getTime() < expires) || row.attempt_dispatched_at !== row.dispatched_at
    || row.attempt_id !== invocation.attempt_id || row.invocation_digest !== invocation.digest) return fail();
  return Object.freeze({ ...row, outbox_id: outboxId, dispatch_fence: fence });
}
