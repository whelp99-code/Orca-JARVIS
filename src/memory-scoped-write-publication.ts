import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { MemoryWriteScopeResolver } from "./memory-access-policy.js";
import type { SpooledDispatchInput } from "./memory-outbox-dispatch-request.js";
import { prepareMemoryScopedWriteRequest } from "./memory-scoped-write-request.js";
import { MemoryScopedWriteSpool } from "./memory-scoped-write-spool.js";

export interface MemoryScopedPublicationOptions {
  readonly authority: AuthorityDb;
  readonly proposal: unknown;
  readonly reviewRequestId: string;
  readonly dispatch: Omit<SpooledDispatchInput, "candidate_id" | "now">;
  readonly resolveWriteScope: MemoryWriteScopeResolver;
  readonly providerInstanceId: string;
  readonly spoolRoot: string;
  readonly clock: () => Date;
}

/** Prepare and durably publish immutable material. This is not approval
 * consumption or enqueue. A failed post-publication check leaves unadmitted
 * bytes for exact retry; callers must never treat a file as write authority. */
export function publishMemoryScopedWriteRequest(options: MemoryScopedPublicationOptions) {
  let previous = Number.NEGATIVE_INFINITY;
  const current = () => {
    const at = options.clock().getTime();
    if (!Number.isFinite(at) || at < previous) throw new JarvisError("SCOPED_PUBLICATION_TIME_INVALID");
    previous = at;
    return new Date(at);
  };
  const prepare = (at: Date) => prepareMemoryScopedWriteRequest(options.authority, options.proposal,
    options.reviewRequestId, options.dispatch, options.resolveWriteScope, options.providerInstanceId, at);
  return options.authority.db.transaction(() => {
    const request = prepare(current());
    const raw = canonicalize(request);
    const spool = new MemoryScopedWriteSpool(options.spoolRoot, options.providerInstanceId);
    const publication = spool.publish(raw, current());
    // Recheck policy, review and original source after filesystem operations.
    if (canonicalize(prepare(current())) !== raw) throw new JarvisError("SCOPED_PUBLICATION_AUTHORITY_CHANGED");
    if (canonicalize(spool.read(request.idempotency_key, current())) !== raw) {
      throw new JarvisError("SCOPED_PUBLICATION_FILE_CHANGED");
    }
    parseMemoryScopedWriteRequestJson(raw, options.providerInstanceId, current());
    return Object.freeze({ schema_version: 4 as const, kind: "prepared" as const,
      writes_authorized: false as const, ...publication });
  }).immediate();
}
