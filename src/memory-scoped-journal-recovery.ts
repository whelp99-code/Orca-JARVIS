import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { createMemoryScopedJournalClient } from "./memory-scoped-journal-client.js";
import { recordMemoryScopedOutboxAcceptance } from "./memory-scoped-outbox-result.js";
import { readMemoryScopedReconciliationRequest, requireMemoryScopedReconciliationLease,
  type MemoryScopedReconcileOptions, type MemoryScopedReconcileLease } from "./memory-scoped-reconciliation.js";

/** Recover the original acceptance under a live reconciliation lease. The client
 * must be a trusted local composition, never a deserialized observation callback.
 * Does not mark provider failure as safe to retry or settle a control command. */
export async function recoverMemoryScopedJournalAcceptance(options: MemoryScopedReconcileOptions,
  lease: MemoryScopedReconcileLease,
  client: Pick<ReturnType<typeof createMemoryScopedJournalClient>, "withRecoveredRequestStatus">,
  now: () => Date, signal?: AbortSignal) {
  requireMemoryScopedReconciliationLease(options.authority, lease, now());
  const request = readMemoryScopedReconciliationRequest(options, lease.outbox_id, now());
  return client.withRecoveredRequestStatus(request, (observation, refresh) => {
    return options.authority.db.transaction(() => {
      let previous = -Infinity;
      const check = () => {
        const current = refresh(), at = new Date(now().getTime());
        if (!Number.isFinite(at.getTime()) || at.getTime() < previous
          || at.getTime() < Date.parse(current.checked_at) || !(at.getTime() < Date.parse(current.valid_until))
          || canonicalize(current.status) !== canonicalize(observation.status))
          throw new JarvisError("SCOPED_JOURNAL_RECOVERY_INVALID");
        requireMemoryScopedReconciliationLease(options.authority, lease, at);
        if (canonicalize(readMemoryScopedReconciliationRequest(options, lease.outbox_id, at)) !== canonicalize(request))
          throw new JarvisError("SCOPED_JOURNAL_RECOVERY_INVALID");
        previous = at.getTime();
        return at;
      };
      const at = check();
      if (observation.status.state === "not_found") {
        check();
        return Object.freeze({ kind: "scoped_journal_not_found" as const, outbox_id: lease.outbox_id });
      }
      const accepted = recordMemoryScopedOutboxAcceptance(options.authority, lease.outbox_id,
        lease.dispatch_fence, request, observation.status.acceptance, at);
      check(); // Revocation or stale lease rolls back acceptance and event together.
      return Object.freeze({ kind: "scoped_journal_acceptance_recovered" as const,
        acceptance: accepted, observed_provider_state: observation.status.state });
    }).immediate();
  }, signal);
}
