import type { MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { MemoryDeletionRecord } from "./memory-deletion-store.js";
import type { MemoryDispositionProofV1 } from "./memory-disposition-proof.js";
import type { MemoryExportRecord } from "./memory-export-store.js";
import type { ReingressGuardObservations } from "./memory-managed-surface-types.js";

export type NotProved = {
  readonly kind: "not_proved";
  readonly code: string;
};

export type VerifiedGenerationObservation = {
  readonly generation_id: string;
  readonly generation_manifest_digest: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
};

export type CompleteProviderSurfaceInventory = {
  readonly manifest_digest: string;
  readonly catalog_rows: 40;
  readonly signature_verified: true;
};

export type CorrectionLifecycleObservation = {
  readonly kind: "correction";
  readonly proof: MemoryDispositionProofV1;
  readonly generation: VerifiedGenerationObservation;
  readonly replacement: {
    readonly artifact_manifest_digest: string;
    readonly target_manifest_digest: string;
  };
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: ReingressGuardObservations;
};

export type DeletionLifecycleObservation = {
  readonly kind: "deletion";
  readonly proof: MemoryDispositionProofV1;
  readonly generation: VerifiedGenerationObservation;
  readonly absence: {
    readonly surface_manifest_digest: string;
    readonly target_manifest_digest: string;
  };
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: ReingressGuardObservations;
};

export type ExportLifecycleObservation = {
  readonly kind: "export";
  readonly proof: MemoryDispositionProofV1;
  readonly generation: VerifiedGenerationObservation;
  readonly export: {
    readonly export_manifest_digest: string;
    readonly file_count: 1;
    readonly byte_count: number;
  };
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: ReingressGuardObservations;
};

export interface MemoryLifecycleObserver {
  correction(record: MemoryCorrectionRecord): Promise<CorrectionLifecycleObservation | NotProved>;
  deletion(record: MemoryDeletionRecord): Promise<DeletionLifecycleObservation | NotProved>;
  export(record: MemoryExportRecord): Promise<ExportLifecycleObservation | NotProved>;
}
