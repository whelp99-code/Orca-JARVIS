import { dirname, join } from "node:path";
import { JarvisError, type AuthorityDb } from "./db.js";
import { createFileMemoryAccessScopeResolver, type AuthenticatedMemorySession } from "./memory-access-policy.js";
import { createProductionMemoryAccessClaim } from "./memory-access-claim-production.js";
import type { MemoryReadFenceProductionConfig } from "./memory-read-fence-production.js";
import { readMemoryReferenceProjectionKey } from "./memory-reference-production.js";
import { createMemoryMembership } from "./memory-membership.js";
import { createMemoryScopedClient } from "./memory-scoped-client.js";
import { createScopedMemoryReference } from "./memory-scoped-reference.js";
import { createSecondBrainTransport, type SecondBrainTransport, type SecondBrainTransportOptions } from "./second-brain-transport.js";

export type ScopedMemoryProductionOptions = {
  readonly profile?: "scoped-record-read-v2" | "scoped-record-read-v3";
  readonly policy_path: string;
  readonly authenticated_session: () => AuthenticatedMemorySession | undefined;
  readonly read_fence_config: MemoryReadFenceProductionConfig;
  readonly projection_key_path?: string;
  readonly clock?: () => Date;
  readonly transport?: SecondBrainTransport;
  readonly transport_options?: Omit<SecondBrainTransportOptions, "contractProfile">;
};
/** Explicit authenticated composition. Does not create keys, policy grants, or
 * sessions. Caller owns the authority DB and any injected transport. */
export function createProductionScopedMemory(authority: AuthorityDb, options: ScopedMemoryProductionOptions) {
  if (typeof options.authenticated_session !== "function") throw new JarvisError("MEMORY_SCOPED_CONFIG_INVALID");
  const clock = options.clock ?? (() => new Date());
  const resolve = createFileMemoryAccessScopeResolver(options.policy_path,
    options.read_fence_config.provider_instance_id, options.authenticated_session);
  const key = readMemoryReferenceProjectionKey(options.projection_key_path
    ?? join(dirname(authority.filename), "memory-projection.key"));
  const membership = createMemoryMembership(key);
  key.fill(0);
  const issue = createProductionMemoryAccessClaim(authority, options.read_fence_config, resolve);
  const statusIssue = createProductionMemoryAccessClaim(authority, options.read_fence_config, resolve, "memory_status");
  // Validate current authenticated status permission before allocating transport.
  statusIssue({ method: "sb_generation_status", arguments: {} }, clock());
  const transport = options.transport ?? createSecondBrainTransport({ ...options.transport_options,
    contractProfile: options.profile ?? "scoped-record-read-v2" });
  const client = createMemoryScopedClient({ issue, status_issue: statusIssue, profile: options.profile ?? "scoped-record-read-v2",
    transport, now: clock, budgets: { max_hits: 32, max_excerpt_bytes: 4096, max_total_bytes: 65536, max_page_bytes: 262144 },
    max_age_ms: 7 * 86400000, expiry_ms: 30 * 86400000 });
  const reader = createScopedMemoryReference(authority, { client, membership, clock, search_limit: 32 });
  let closing: Promise<void> | undefined;
  return { reader, client, close: (): Promise<void> => options.transport === undefined
    ? closing ??= transport.close() : Promise.resolve() };
}
