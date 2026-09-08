import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { MemoryCorrectionCancellationIssuer } from "./memory-correction-cancellation-issuer.js";
import type { CorrectionCancellationIntentV1 } from "./memory-correction-cancellation-intent.js";
import { memoryEffectInstant, rejectMemoryEffect, snapshotMemoryEffectValue } from "./second-brain-effect-v2-canonical.js";
import { SecondBrainTransportError, type SecondBrainTransport } from "./second-brain-transport-contract.js";

const INVALID = "MEMORY_CANCELLATION_ACCEPTANCE_INVALID";
const schema = z.object({ schema_version: z.literal(1), kind: z.literal("correction_cancellation_accepted"),
  state: z.literal("suppression_pending"), intent_id: z.string(), intent_digest: z.string(),
  original_request_id: z.string(), provider_instance_id: z.string(),
  tombstone_sequence: z.number().int().safe().min(1), tombstone_set_root: z.string(),
  accepted_at: z.iso.datetime({ precision: 3 }) }).strict();
export type CorrectionCancellationAcceptedV1 = z.infer<typeof schema>;

export function requireCorrectionCancellationAccepted(value: unknown, intent: CorrectionCancellationIntentV1,
  now: Date): CorrectionCancellationAcceptedV1 {
  const parsed = schema.safeParse(snapshotMemoryEffectValue(value));
  if (!parsed.success) rejectMemoryEffect(INVALID);
  const result = parsed.data;
  if (result.intent_id !== intent.intent_id || result.intent_digest !== intent.intent_digest
    || result.original_request_id !== intent.original_delegation.request_id
    || result.provider_instance_id !== intent.provider_instance_id
    || result.tombstone_sequence !== intent.tombstone.sequence || result.tombstone_set_root !== intent.tombstone.set_root
    || !Number.isFinite(now.getTime())) rejectMemoryEffect(INVALID);
  const accepted = memoryEffectInstant(result.accepted_at, INVALID);
  if (accepted < memoryEffectInstant(intent.not_before, INVALID) || accepted >= memoryEffectInstant(intent.expires_at, INVALID)
    || accepted > now.getTime()) rejectMemoryEffect(INVALID);
  return Object.freeze(result);
}

/** Submit only the exact durable DB intent; pending is never cursor completion. */
export async function submitDatabaseCorrectionCancellation(issuer: MemoryCorrectionCancellationIssuer,
  correctionId: string, signingKeyId: string, privateKey: KeyObject, transport: SecondBrainTransport,
  clock: () => Date): Promise<CorrectionCancellationAcceptedV1> {
  const intent = issuer.issue(correctionId, signingKeyId, privateKey);
  const response = await transport.call("sb_submit_cancellation", { intent }, { beforeSend: () => {
    try {
      // Runs synchronously after handshake/queue waits immediately before stdin publication.
      if (canonicalize(issuer.issue(correctionId, signingKeyId, privateKey)) !== canonicalize(intent)) throw new Error(INVALID);
    } catch {
      throw new SecondBrainTransportError("MEMORY_CANCELLATION_AUTHORITY_CHANGED", "cancelled", { generation: 0 });
    }
  } });
  if (response.kind !== "data") rejectMemoryEffect(response.kind === "error" ? response.code : INVALID);
  return requireCorrectionCancellationAccepted(response.value, intent, clock());
}
