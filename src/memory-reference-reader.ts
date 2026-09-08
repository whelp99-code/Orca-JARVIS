import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryReadPrivacyState, isMemoryReadSuppressed, type MemoryMembership } from "./memory-read-privacy.js";
import { prepareMemoryReference, MemoryReferenceError, type MemoryReferenceBudgets, type PreparedMemoryReference } from "./memory-reference-context.js";
import type { SecondBrainReadAdapter, SecondBrainGenerationBinding } from "./second-brain-adapter-types.js";
import type { SecondBrainOutcome } from "./second-brain-transport.js";

export type MemoryReferenceReaderOptions = {
  readonly authority: AuthorityDb; readonly adapter: SecondBrainReadAdapter;
  readonly membership: MemoryMembership; readonly clock: () => Date;
  readonly generation_status: () => Promise<SecondBrainOutcome>;
  readonly assert_authorized?: (at: Date) => void;
};
export type CheckedMemoryReference = PreparedMemoryReference & {
  /** Local receipt time of the final status response, not a perpetual freshness guarantee. */
  readonly provider_status_received_at: string;
};

/** Explicit local owner read, not an agent delivery receipt or project authorization. */
export class MemoryReferenceReader {
  constructor(private readonly options: MemoryReferenceReaderOptions) {}

  async read(query: string, budgets: MemoryReferenceBudgets,
    releaseProvider?: () => Promise<void>): Promise<CheckedMemoryReference> {
    const { authority, adapter, clock } = this.options;
    const now = clock();
    // Validate query and the empty envelope budget before making any provider call.
    prepareMemoryReference({ query, budgets, now, outcome: { kind: "no_data",
      checked_at: now.toISOString(), fresh_until: now.toISOString() } });
    const initial = memoryReadPrivacyState(authority);
    let outcome: Awaited<ReturnType<SecondBrainReadAdapter["search"]>>;
    let status: SecondBrainOutcome;
    let generation: SecondBrainGenerationBinding;
    let statusReceivedAt: string;
    try {
      const before = await this.options.generation_status();
      if (!matchesStatus(before, undefined, initial.tombstone_sequence, initial.tombstone_set_root)
        || before.kind !== "data") throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
      generation = {
        provider_instance_id: String(before.value["provider_instance_id"]),
        generation_id: String(before.value["generation_id"]),
        generation_manifest_digest: String(before.value["generation_manifest_digest"]),
        vault_head: String(before.value["vault_head"]), vault_tree: String(before.value["vault_tree"]),
        tombstone_sequence: initial.tombstone_sequence, tombstone_set_root: initial.tombstone_set_root,
      };
      outcome = await adapter.search(query);
      if (outcome.kind !== "current" && outcome.kind !== "no_data") {
        throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
      }
      status = await this.options.generation_status();
      statusReceivedAt = clock().toISOString();
      // CLI-owned transport shutdown can take time. Complete it before the final
      // local privacy/freshness transaction; this callback receives no content.
      await releaseProvider?.();
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
    }
    try { return authority.db.transaction(() => {
      const final = memoryReadPrivacyState(authority);
      if (canonicalize(initial) !== canonicalize(final)) throw new JarvisError("MEMORY_REFERENCE_PRIVACY_CHANGED");
      this.options.assert_authorized?.(clock());
      if (!matchesStatus(status, generation, final.tombstone_sequence, final.tombstone_set_root)) {
        throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
      }
      if (outcome.kind === "current") {
        // The entire reference is withheld when a local suppression matches. This
        // avoids emitting blocked identities or disguising that fact as no_data.
        for (const item of outcome.evidence) {
          if (item.record === null) throw new JarvisError("MEMORY_REFERENCE_BINDING_INVALID");
          if (!matchesStatus(status, item.record.generation, final.tombstone_sequence, final.tombstone_set_root)) {
            throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
          }
          if (isMemoryReadSuppressed(authority, item, this.options.membership)) {
            throw new JarvisError("MEMORY_REFERENCE_SUPPRESSED");
          }
        }
      }
      return { ...prepareMemoryReference({ query, budgets, outcome, now: clock() }),
        provider_status_received_at: statusReceivedAt };
    })(); } catch (error) {
      if (error instanceof JarvisError || error instanceof MemoryReferenceError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PRIVACY_UNAVAILABLE");
    }
  }
}

function matchesStatus(status: SecondBrainOutcome, expected: SecondBrainGenerationBinding | undefined,
  sequence: number, root: string): boolean {
  if (status.kind !== "data") return false;
  const value = status.value;
  if (value["schema_version"] !== 1 || value["pointer_health"] !== "healthy" || value["journal_health"] !== "healthy"
    || value["tombstone_sequence"] !== sequence || value["tombstone_set_root"] !== root
    || typeof value["provider_instance_id"] !== "string" || value["provider_instance_id"].length === 0
    || typeof value["generation_id"] !== "string" || !/^sbgen:v1:[0-9a-f]{64}$/.test(value["generation_id"])
    || typeof value["generation_manifest_digest"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value["generation_manifest_digest"])
    || typeof value["vault_head"] !== "string" || !/^[0-9a-f]{40}$/.test(value["vault_head"])
    || typeof value["vault_tree"] !== "string" || !/^[0-9a-f]{40}$/.test(value["vault_tree"])) return false;
  return expected === undefined || Object.entries(expected).every(([key, item]) => value[key] === item);
}
