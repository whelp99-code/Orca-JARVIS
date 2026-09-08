import { canonicalize } from "./canonical.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { MemoryWriteScopeResolver } from "./memory-access-policy.js";
import { prepareMemoryScopedWriteWithPolicy } from "./memory-scoped-write-policy.js";
import { resolveSpooledDispatch, type SpooledDispatchInput } from "./memory-outbox-dispatch-request.js";
import { memoryHash } from "./memory-candidate-values.js";

export interface MemoryScopedWriteRequestMaterial {
  readonly schema_version: 4;
  readonly profile: "scoped-remember-v1";
  readonly provider_instance_id: string;
  readonly operation: "remember";
  readonly source_request: ReturnType<typeof resolveSpooledDispatch>;
  readonly preparation: ReturnType<typeof prepareMemoryScopedWriteWithPolicy>["preparation"];
  readonly writer: ReturnType<typeof prepareMemoryScopedWriteWithPolicy>["writer"];
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly request_id: string;
}

/** Build the additive scoped request material. This does not consume a review,
 * enqueue or call a provider. Only the versioned acceptance path may dispatch it. */
export function prepareMemoryScopedWriteRequest(authority: AuthorityDb, proposal: unknown,
  reviewRequestId: string, dispatch: Omit<SpooledDispatchInput, "candidate_id" | "now">,
  resolveWriteScope: MemoryWriteScopeResolver, providerInstanceId: string, now: Date): MemoryScopedWriteRequestMaterial {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerInstanceId)) {
    throw new JarvisError("MEMORY_SCOPED_REQUEST_INVALID");
  }
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new JarvisError("MEMORY_SCOPED_REQUEST_INVALID");
  return authority.db.transaction(() => {
    const checked = prepareMemoryScopedWriteWithPolicy(authority, proposal, reviewRequestId, dispatch, resolveWriteScope, new Date(at));
    if (checked.provider_instance_id !== providerInstanceId) throw new JarvisError("MEMORY_SCOPED_REQUEST_PROVIDER_MISMATCH");
    const preparation = checked.preparation;
    const sourceRequest = resolveSpooledDispatch({ ...dispatch, candidate_id: preparation.binding.identity.candidate_id, now: new Date(at) });
    // V1 remains supported separately. A multiline scoped request must carry the
    // exact validated V3 body, never a normalized or relabelled V1 request.
    if (sourceRequest.schema_version !== 3 || sourceRequest.operation !== "remember") {
      throw new JarvisError("MEMORY_SCOPED_REQUEST_SOURCE_VERSION_UNSUPPORTED");
    }
    const idempotency = memoryHash("orca-jarvis/memory-scoped-write-idempotency/v4\0", {
      provider_instance_id: providerInstanceId, identity_digest: preparation.binding.identity_digest });
    const base = Object.freeze({ schema_version: 4 as const, profile: "scoped-remember-v1" as const,
      provider_instance_id: providerInstanceId, operation: "remember" as const,
      source_request: sourceRequest, preparation, writer: checked.writer,
      created_at: sourceRequest.created_at,
      expires_at: new Date(Math.min(Date.parse(checked.valid_until), Date.parse(sourceRequest.expires_at))).toISOString(),
      idempotency_key: `memidem:scoped:v4:${idempotency.slice(7)}` });
    const digest = memoryHash("orca-jarvis/memory-scoped-write-request/v4\0", base);
    const request = Object.freeze({ ...base, request_digest: digest, request_id: `memreq:scoped:v4:${digest.slice(7)}` });
    parseMemoryScopedWriteRequestJson(canonicalize(request), providerInstanceId, new Date(at));
    return request;
  })();
}
