import type { z } from "zod";
import type {
  MemoryEffectAcceptedV2,
  MemoryEffectDelegationV2,
  MemoryEffectExpectedPriorV2,
  MemoryEffectPayloadV2,
  MemoryEffectScopeV2,
  MemoryEffectWriteRequestV2,
  MemoryTombstoneChainEntryV2,
  MemoryTombstoneHighWaterV2,
  ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";
import type { SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";
import type { MemoryWriteRequestSchema } from "./memory-effect-write-zod.js";

export type MemoryWriteRequestV1 = SecondBrainWriteRequestV1;
export type MemoryEffectWriteRequest = MemoryEffectWriteRequestV2;
export type MemoryWriteRequest = MemoryWriteRequestV1 | MemoryEffectWriteRequest;
export type MemoryWriteRequestWire = z.infer<typeof MemoryWriteRequestSchema>;
export type MemoryEffectAccepted = MemoryEffectAcceptedV2;
export type MemoryEffectDelegationV1 = MemoryEffectDelegationV2;
export type MemoryEffectExpectedPrior = MemoryEffectExpectedPriorV2;
export type MemoryEffectPayload = MemoryEffectPayloadV2;
export type MemoryEffectScope = MemoryEffectScopeV2;
export type MemoryTombstoneChainEntry = MemoryTombstoneChainEntryV2;
export type MemoryTombstoneHighWater = MemoryTombstoneHighWaterV2;
export type ResolvedMemoryTargetV1 = ResolvedMemoryTargetV2;
