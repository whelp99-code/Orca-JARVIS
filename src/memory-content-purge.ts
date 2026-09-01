import type {
  MemoryAuthorityCompactorPort,
  MemoryCompactionRequest,
} from "./memory-compaction-types.js";
import type { CompleteMemorySurfaceInventory } from "./memory-managed-surface-types.js";

export type MemoryPurgeResult = {
  readonly purge_id: string;
  readonly receipt_digest: string;
  readonly inventory: CompleteMemorySurfaceInventory;
};

export type MemoryContentPurgeOptions = {
  readonly compactor: MemoryAuthorityCompactorPort;
  readonly request: MemoryCompactionRequest;
};

export async function purgeMemoryContent(
  options: MemoryContentPurgeOptions,
): Promise<MemoryPurgeResult> {
  const observation = await options.compactor.compact(options.request);
  return { purge_id: observation.purge_id,
    receipt_digest: observation.compaction_receipt_digest,
    inventory: observation.inventory };
}
