import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { MemoryWriteScopeResolver } from "./memory-access-policy.js";
import { prepareMemoryScopedWriteFromDispatch } from "./memory-scoped-write-payload.js";
import type { SpooledDispatchInput } from "./memory-outbox-dispatch-request.js";

/** Current operator write policy plus existing source/review authority checks.
 * Still preparation only: the enqueue transaction must repeat these checks and
 * consume the review atomically with the versioned scoped request. */
export function prepareMemoryScopedWriteWithPolicy(authority: AuthorityDb, proposal: unknown,
  reviewRequestId: string, dispatch: Omit<SpooledDispatchInput, "candidate_id" | "now">,
  resolveWriteScope: MemoryWriteScopeResolver, now: Date) {
  const at = now.getTime();
  const fail = (): never => { throw new JarvisError("MEMORY_SCOPED_WRITE_POLICY_INVALID"); };
  if (!Number.isFinite(at)) return fail();
  return authority.db.transaction(() => {
    const scope = resolveWriteScope(new Date(at));
    if (scope === undefined || scope.method !== "sb_write_request") return fail();
    const snapshot = canonicalize(scope);
    const prepared = prepareMemoryScopedWriteFromDispatch(authority, proposal, reviewRequestId, dispatch, new Date(at));
    const identity = prepared.binding.identity;
    const expiry = Date.parse(scope.valid_until);
    if (scope.principal_id !== identity.owner || scope.policy_revision !== identity.policy_revision
      || !Number.isFinite(expiry) || expiry <= at
      || (!identity.projects.length && scope.projects.length > 0)
      || !identity.projects.every(project => scope.projects.includes(project))) return fail();
    const current = resolveWriteScope(new Date(at));
    if (current === undefined || canonicalize(current) !== snapshot || canonicalize(scope) !== snapshot) return fail();
    // The resolver may execute application callbacks. Recheck persisted authority
    // after the last callback instead of trusting the first database snapshot.
    const checked = prepareMemoryScopedWriteFromDispatch(authority, proposal, reviewRequestId, dispatch, new Date(at));
    if (checked.preparation_digest !== prepared.preparation_digest) return fail();
    return Object.freeze({ preparation: checked,
      writer: Object.freeze({ principal_id: scope.principal_id, agent_id: scope.agent_id, session_id: scope.session_id }),
      valid_until: new Date(Math.min(expiry, Date.parse(checked.binding.expires_at))).toISOString(),
      writes_authorized: false as const });
  })();
}
