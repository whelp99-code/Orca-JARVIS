import type { MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { MemoryDeletionRecord } from "./memory-deletion-store.js";
import type { MemoryDispositionProofV1 } from "./memory-disposition-proof.js";
import type { MemoryExportRecord } from "./memory-export-store.js";
import type {
  CompleteProviderSurfaceInventory,
  CompleteReingressGuardObservations,
  MemoryLifecycleObservedResult,
} from "./memory-lifecycle-observation-manifest.js";

export type {
  CompleteProviderSurfaceInventory,
  CompleteReingressGuardObservations,
} from "./memory-lifecycle-observation-manifest.js";

export type NotProved = {
  readonly kind: "not_proved";
  readonly code: string;
  /**
   * Set only when the provider decided against the request before its apply phase began, so the
   * lane may stop reconciling. Absence means the outcome is still uncertain and must not be ended.
   */
  readonly refused?: true;
};

export type VerifiedGenerationObservation = {
  readonly generation_id: string;
  readonly generation_manifest_digest: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
};

type ObservedCorrection = Extract<MemoryLifecycleObservedResult, { readonly kind: "correction" }>;
type ObservedDeletion = Extract<MemoryLifecycleObservedResult, { readonly kind: "deletion" }>;
type ObservedExport = Extract<MemoryLifecycleObservedResult, { readonly kind: "export" }>;

type ObservedLifecycle = {
  readonly proof: MemoryDispositionProofV1;
  readonly generation: VerifiedGenerationObservation;
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: CompleteReingressGuardObservations;
};

export type CorrectionLifecycleObservation = ObservedLifecycle & {
  readonly kind: "correction";
  readonly replacement: ObservedCorrection;
};

export type DeletionLifecycleObservation = ObservedLifecycle & {
  readonly kind: "deletion";
  readonly absence: ObservedDeletion;
};

export type ExportLifecycleObservation = ObservedLifecycle & {
  readonly kind: "export";
  readonly export: ObservedExport;
};

export interface MemoryLifecycleObserver {
  correction(record: MemoryCorrectionRecord): Promise<CorrectionLifecycleObservation | NotProved>;
  deletion(record: MemoryDeletionRecord): Promise<DeletionLifecycleObservation | NotProved>;
  export(record: MemoryExportRecord): Promise<ExportLifecycleObservation | NotProved>;
}
