import { createHash, randomUUID, sign } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { createProductionMemoryReadAuthorization, type MemoryReadFenceProductionConfig } from "./memory-read-fence-production.js";

export type AuthorizedMemoryReadScope = {
  readonly principal_id: "principal:owner";
  readonly agent_id: string;
  readonly session_id: string;
  readonly projects: readonly string[];
  readonly policy_revision: string;
  readonly valid_until: string;
};
export type MemoryAccessRequest = { readonly method: string; readonly arguments: Readonly<Record<string, unknown>> };
// This port must use authenticated server/session and current policy state. It is
// not an HTTP body parser, project-name lookup, or permission inferred from a task.
export type MemoryAccessScopeResolver = (at: Date, request: MemoryAccessRequest) => AuthorizedMemoryReadScope | undefined;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (): never => { throw new JarvisError("MEMORY_ACCESS_SCOPE_UNAVAILABLE"); };
function requestDigest(request: MemoryAccessRequest): string {
  if (!id.test(request.method)) return fail();
  const encoded = canonicalize(request);
  if (encoded !== encoded.normalize("NFC")) return fail();
  return `sha256:${createHash("sha256").update("orca-jarvis/memory-access-request/v1\0" + encoded).digest("hex")}`;
}

/** No keys or permissions are created. Re-resolves scope and checks current key
 * authority for every invocation. Not wired to legacy unscoped adapters. */
export function createProductionMemoryAccessClaim(authority: AuthorityDb,
  config: MemoryReadFenceProductionConfig, resolveScope: MemoryAccessScopeResolver, purpose: "memory_read" | "memory_status" = "memory_read") {
  const authorize = createProductionMemoryReadAuthorization(authority, config, purpose);
  if (authorize === undefined) return fail();
  return (request: MemoryAccessRequest, at: Date) => {
    if ((purpose === "memory_status") !== (request.method === "sb_generation_status" || request.method === "sb_request_status")) return fail();
    // A resolver must not change the exact request that will be signed.
    const observed = at.getTime();
    if (!Number.isFinite(observed)) return fail();
    const resolverClock = new Date(observed);
    const expected = requestDigest(request);
    const scope = resolveScope(resolverClock, request);
    if (resolverClock.getTime() !== observed || at.getTime() !== observed) return fail();
    if (scope === undefined || scope.principal_id !== "principal:owner"
      || ![scope.agent_id, scope.session_id, scope.policy_revision].every(value => id.test(value))
      || scope.projects.length > 64 || new Set(scope.projects).size !== scope.projects.length
      || [...scope.projects].sort().some((value, index) => value !== scope.projects[index])
      || scope.projects.some(value => !value.startsWith("project:") || !id.test(value) || !id.test(value.slice(8)))
      || !Number.isFinite(at.getTime()) || !Number.isFinite(Date.parse(scope.valid_until))
      || scope.valid_until !== new Date(scope.valid_until).toISOString() || Date.parse(scope.valid_until) <= at.getTime()
      || requestDigest(request) !== expected) return fail();
    if (resolverClock.getTime() !== observed || at.getTime() !== observed) return fail();
    const issuedAt = new Date(observed);
    const { fence, private_key: key } = authorize(issuedAt);
    const body = { schema_version: 1, provider_instance_id: fence.provider_instance_id,
      principal_id: scope.principal_id, agent_id: scope.agent_id, session_id: scope.session_id,
      projects: [...scope.projects], policy_revision: scope.policy_revision, purpose,
      request_digest: expected, read_fence_digest: fence.fence_digest, issued_at: issuedAt.toISOString(),
      expires_at: new Date(Math.min(Date.parse(scope.valid_until), Date.parse(fence.expires_at))).toISOString(),
      nonce: `nonce:${randomUUID()}`, signing_key_id: fence.signing_key_id };
    const signature = sign(null, Buffer.from("orca-jarvis/memory-access-claim/v1\0" + canonicalize(body)), key).toString("base64url");
    return { read_fence: fence, access_claim: { ...body, signature } };
  };
}
