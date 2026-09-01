import type { MemorySagaRuntime } from "./memory-saga-runtime.js";
import type {
  ExternalErasureReceiptV2,
  MemoryEffectScopeV2,
  ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

export type PrepareMemoryDeletionInput = {
  readonly deletion_id: string;
  readonly correlation_id: string;
  readonly provider_instance_id: string;
  readonly targets: readonly ResolvedMemoryTargetV2[];
  readonly scope: MemoryEffectScopeV2;
  readonly erasure_claim: "managed_erasure" | "provider_local_suppression";
  readonly external_receipts: readonly ExternalErasureReceiptV2[];
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly nonce: string;
};

export type MemoryDeletionSagaOptions = MemorySagaRuntime;
