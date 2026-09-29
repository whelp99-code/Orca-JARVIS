import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import type { PrepareMemoryCorrectionInput } from "./memory-correction-types.js";
import type { PrepareMemoryDeletionInput } from "./memory-deletion-types.js";
import type { PrepareMemoryExportInput } from "./memory-export-types.js";

export type MemoryLifecycleExecution =
  | { readonly kind: "correction"; readonly id: string;
      readonly state: "approved" | "queued" | "dispatching" | "reconciling" | "provider_proved" | "settled" | "conflict";
      readonly request_digest?: string }
  | { readonly kind: "deletion"; readonly id: string;
      readonly state: "requested" | "approved" | "suppressed" | "queued" | "applying" | "reconciling" | "provider_proved" | "settled" | "conflict" }
  | { readonly kind: "export"; readonly id: string;
      readonly state: "requested" | "approved" | "queued" | "writing" | "provider_proved" | "available" | "expired" | "invalidated" };

export type MemoryLifecycleCycle = {
  readonly corrections: number;
  readonly deletions: number;
  readonly exports: number;
  readonly expired_exports: number;
  readonly correction_controls_reconciled?: number;
  readonly correction_control_error?: string;
};

export interface MemoryLifecycleService {
  prepareCorrection(input: PrepareMemoryCorrectionInput): Promise<ControlCommandRequestInput>;
  prepareDeletion(input: PrepareMemoryDeletionInput): Promise<ControlCommandRequestInput>;
  prepareExport(input: PrepareMemoryExportInput): Promise<ControlCommandRequestInput>;
  execute(command: ClaimedControlCommand): Promise<MemoryLifecycleExecution>;
  reconcilePending(limit: number): Promise<MemoryLifecycleCycle>;
  expireExports(now: Date): Promise<MemoryLifecycleCycle>;
  close(): Promise<void>;
}
