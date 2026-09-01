import type { CompleteProviderSurfaceInventory } from "./memory-lifecycle-observation-types.js";
import type {
  CompleteMemorySurfaceInventory,
  ReingressGuardObservations,
} from "./memory-managed-surface-types.js";

export type MemoryCompactionRequest = {
  readonly lane: "correction" | "deletion";
  readonly lane_id: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly tombstone: {
    readonly sequence: number;
    readonly set_root: string;
  };
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: ReingressGuardObservations;
};

export type MemoryCompactionObservation = {
  readonly purge_id: string;
  readonly compaction_receipt_digest: string;
  readonly source_generation: number;
  readonly result_generation: number;
  readonly integrity_check: "ok";
  readonly foreign_key_errors: 0;
  readonly old_database_disposed: true;
  readonly old_wal_disposed: true;
  readonly old_shm_disposed: true;
  readonly old_journal_disposed: true;
  readonly old_fd_count: 0;
  readonly reader_drain_digest: string;
  readonly inventory: CompleteMemorySurfaceInventory;
};

export type MemoryCompactionRecovery = MemoryCompactionObservation
  | { readonly state: "reconciling"; readonly old_fd_count: number };

export interface MemoryAuthorityCompactorPort {
  compact(request: MemoryCompactionRequest): Promise<MemoryCompactionObservation>;
  recover(purgeId: string): Promise<MemoryCompactionRecovery>;
}
