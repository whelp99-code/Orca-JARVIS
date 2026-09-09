import { JarvisError } from "./db.js";
import type { createMemoryScopedClient } from "./memory-scoped-client.js";
import type { createMemoryScopedJournalClient } from "./memory-scoped-journal-client.js";
import { recoverMemoryScopedJournalAcceptance } from "./memory-scoped-journal-recovery.js";
import { claimMemoryScopedReconciliation, releaseMemoryScopedReconciliation,
  type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";
import { readMemoryScopedSettlement, settleMemoryScopedCompletion } from "./memory-scoped-settlement.js";
import type { MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";

export type MemoryScopedReconcileOnceOptions = MemoryScopedReconcileOptions & {
  readonly journal: Pick<ReturnType<typeof createMemoryScopedJournalClient>, "withRecoveredRequestStatus">;
  readonly completion: Pick<ReturnType<typeof createMemoryScopedClient>, "withRememberedCompletion">;
  readonly roots: MemoryOutboxSpoolRoots;
  readonly clock: () => Date;
};

/** One explicitly selected, already-dispatched outbox. Never dispatches, scans a
 * queue, retries writes, or interprets failed/not_found as absence of effects.
 * A failed run retains its bounded lease until expiry for normal crash recovery. */
export async function reconcileMemoryScopedOnce(options: MemoryScopedReconcileOnceOptions,
  outboxId: string, worker: string, leaseMs: number, signal?: AbortSignal) {
  const active = () => { if (signal?.aborted) throw new JarvisError("SECOND_BRAIN_CANCELLED"); };
  active();
  const settled = readMemoryScopedSettlement(options, outboxId, options.clock());
  if (settled !== undefined) return settled;
  const claimed = claimMemoryScopedReconciliation(options, outboxId, worker, options.clock(), leaseMs);
  if (claimed === undefined) return Object.freeze({ kind: "scoped_reconciliation_not_claimed" as const, outbox_id: outboxId });
  active();
  const recovery = await recoverMemoryScopedJournalAcceptance(options, claimed.lease, options.journal, options.clock, signal);
  active();
  if (recovery.kind === "scoped_journal_acceptance_recovered" && recovery.observed_provider_state === "proved") {
    // Historical journal proof is only a trigger. Existing completion does its
    // own current status/artifact/status reads, authority checks and atomic commit.
    return settleMemoryScopedCompletion(options, claimed.lease, options.completion, options.clock, options.roots, signal);
  }
  releaseMemoryScopedReconciliation(options.authority, claimed.lease, options.clock());
  return Object.freeze({ kind: "scoped_reconciliation_deferred" as const, outbox_id: outboxId,
    observed_provider_state: recovery.kind === "scoped_journal_not_found" ? "not_found" : recovery.observed_provider_state,
    recovery });
}
