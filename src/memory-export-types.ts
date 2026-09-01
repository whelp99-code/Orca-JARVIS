import type { MemorySagaRuntime } from "./memory-saga-runtime.js";
import type { MemoryEffectScopeV2, ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

export type PrepareMemoryExportInput = {
  readonly export_id: string;
  readonly correlation_id: string;
  readonly provider_instance_id: string;
  readonly targets: readonly ResolvedMemoryTargetV2[];
  readonly scope: MemoryEffectScopeV2;
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly nonce: string;
};

export type MemoryExportSagaOptions = MemorySagaRuntime;
