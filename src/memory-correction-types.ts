import type { MemorySagaRuntime } from "./memory-saga-runtime.js";
import type { MemoryEffectScopeV2, ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

export type PrepareMemoryCorrectionInput = {
  readonly control_request_id: string;
  readonly candidate_id: string;
  readonly provider_instance_id: string;
  readonly targets: readonly [ResolvedMemoryTargetV2];
  readonly scope: MemoryEffectScopeV2;
  readonly content: string;
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly nonce: string;
};

export type MemoryCorrectionSagaOptions = MemorySagaRuntime;
