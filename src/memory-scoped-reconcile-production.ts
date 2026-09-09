import { JarvisError, type AuthorityDb } from "./db.js";
import { createFileMemoryAccessScopeResolver, type AuthenticatedMemorySession } from "./memory-access-policy.js";
import { createProductionMemoryAccessClaim } from "./memory-access-claim-production.js";
import type { MemoryReadFenceProductionConfig } from "./memory-read-fence-production.js";
import type { MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import { createMemoryScopedClient } from "./memory-scoped-client.js";
import { createMemoryScopedJournalClient } from "./memory-scoped-journal-client.js";
import { reconcileMemoryScopedOnce } from "./memory-scoped-reconcile-once.js";
import { readMemoryScopedReconciliationRequest } from "./memory-scoped-reconciliation.js";
import { createSecondBrainTransport, type SecondBrainTransport, type SecondBrainTransportOptions } from "./second-brain-transport.js";

export type ScopedReconcileProductionOptions = {
  readonly policy_path: string;
  readonly authenticated_session: () => AuthenticatedMemorySession | undefined;
  readonly read_fence_config: MemoryReadFenceProductionConfig;
  readonly spool_root: string;
  readonly roots: MemoryOutboxSpoolRoots;
  readonly clock?: () => Date;
  readonly journal_transport?: SecondBrainTransport;
  readonly completion_transport?: SecondBrainTransport;
  readonly journal_transport_options?: Omit<SecondBrainTransportOptions, "contractProfile">;
  readonly completion_transport_options?: Omit<SecondBrainTransportOptions, "contractProfile">;
};

/** Host supplies an authenticated session, existing keys and fixed routing. No
 * login, policy creation, discovery, or authority inferred from CLI labels. */
export function createProductionScopedReconciler(authority: AuthorityDb, options: ScopedReconcileProductionOptions) {
  if (typeof options.authenticated_session !== "function") throw new JarvisError("MEMORY_SCOPED_RECONCILE_CONFIG_INVALID");
  const now = options.clock ?? (() => new Date());
  const resolve = createFileMemoryAccessScopeResolver(options.policy_path,
    options.read_fence_config.provider_instance_id, options.authenticated_session);
  const issue = createProductionMemoryAccessClaim(authority, options.read_fence_config, resolve);
  const status = createProductionMemoryAccessClaim(authority, options.read_fence_config, resolve, "memory_status");
  const shared = { authority, spoolRoot: options.spool_root, providerInstanceId: options.read_fence_config.provider_instance_id };
  let journalTransport: SecondBrainTransport | undefined, completionTransport: SecondBrainTransport | undefined;
  let closing: Promise<void> | undefined;
  return {
    runOnce: async (outboxId: string, worker: string, leaseMs = 30000, signal?: AbortSignal) => {
      if (closing !== undefined) throw new JarvisError("MEMORY_SCOPED_RECONCILE_CLOSED");
      if (signal?.aborted) throw new JarvisError("SECOND_BRAIN_CANCELLED");
      const request = readMemoryScopedReconciliationRequest(shared, outboxId, now());
      // Fail current authorization before claiming a lease or allocating a transport.
      const authorization = status({ method: "sb_request_status", arguments: { request } }, now()).access_claim;
      const scope = request.preparation.binding.identity;
      if (authorization.principal_id !== scope.owner || authorization.policy_revision !== scope.policy_revision
        || (scope.projects.length === 0 ? authorization.projects.length !== 0 : scope.projects.some(p => !authorization.projects.includes(p))))
        throw new JarvisError("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
      journalTransport ??= options.journal_transport ?? createSecondBrainTransport({ ...options.journal_transport_options, contractProfile: "scoped-request-status-v1" });
      completionTransport ??= options.completion_transport ?? createSecondBrainTransport({ ...options.completion_transport_options, contractProfile: "scoped-record-read-v5" });
      const budgets = { max_hits: 32, max_excerpt_bytes: 4096, max_total_bytes: 65536, max_page_bytes: 262144 };
      const journal = createMemoryScopedJournalClient({ issue: status, transport: journalTransport, now, budgets });
      const completion = createMemoryScopedClient({ issue, status_issue: status, profile: "scoped-record-read-v5",
        transport: completionTransport, now, budgets, max_age_ms: 7 * 86400000, expiry_ms: 30 * 86400000 });
      return reconcileMemoryScopedOnce({ ...shared, journal, completion, roots: options.roots, clock: now }, outboxId, worker, leaseMs, signal);
    },
    close: (): Promise<void> => closing ??= Promise.all([
      options.journal_transport === undefined ? journalTransport?.close() : undefined,
      options.completion_transport === undefined ? completionTransport?.close() : undefined,
    ]).then(() => undefined),
  };
}
