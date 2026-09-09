import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { readCurrentDispatchedMemoryScopedOutbox } from "./memory-scoped-outbox-reader.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";

/** Uses server-owned authenticated session/current policy resolution and the
 * existing authority DB. Never derive resolveWriteScope from incoming labels.
 * The result is a current decision, not a reusable credential or send permission.
 * Provider adapters must bind it to their request and enforce valid_until at use. */
export function verifyMemoryScopedProviderWrite(
  input: Parameters<typeof readCurrentDispatchedMemoryScopedOutbox>[0], value: unknown,
) {
  const fail = (): never => { throw new JarvisError("SCOPED_PROVIDER_AUTHORITY_INVALID"); };
  let previous = Number.NEGATIVE_INFINITY;
  let validUntil = Number.POSITIVE_INFINITY;
  const clock = () => {
    const at = input.clock().getTime();
    if (!Number.isFinite(at) || at < previous || !(at < validUntil)) return fail();
    previous = at; return new Date(at);
  };
  const encoded = canonicalize(value);
  const request = parseMemoryScopedWriteRequestJson(encoded, input.providerInstanceId, clock());
  validUntil = Date.parse(request.expires_at);
  const options = { ...input, clock, resolveWriteScope: (at: Date) => {
    const sampled = at.getTime();
    const scope = input.resolveWriteScope(at);
    if (at.getTime() !== sampled) return fail();
    if (scope !== undefined) validUntil = Math.min(validUntil, Date.parse(scope.valid_until));
    return scope;
  } };
  return input.authority.db.transaction(() => {
    const row = input.authority.db.prepare(`SELECT outbox_id,dispatch_fence FROM memory_outbox
      WHERE request_id=? AND request_digest=? AND request_profile='scoped-v4'`)
      .get(request.request_id, request.request_digest) as { outbox_id: string; dispatch_fence: number | null } | undefined;
    if (row?.dispatch_fence === null || row === undefined) return fail();
    const actual = readCurrentDispatchedMemoryScopedOutbox(options, row.outbox_id, row.dispatch_fence);
    if (canonicalize(actual) !== encoded) return fail();
    const checked = clock();
    return Object.freeze({ kind: "current_scoped_dispatch" as const, outbox_id: row.outbox_id,
      dispatch_fence: row.dispatch_fence, provider_instance_id: request.provider_instance_id,
      request_id: request.request_id, request_digest: request.request_digest,
      scope_digest: request.preparation.binding.identity_digest,
      checked_at: checked.toISOString(), valid_until: new Date(validUntil).toISOString() });
  }).immediate();
}
