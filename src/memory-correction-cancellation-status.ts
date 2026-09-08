import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { CorrectionCancellationIntentV1 } from "./memory-correction-cancellation-intent.js";
import { requireCorrectionCancellationResult, type CorrectionCancellationResultV1 } from "./memory-correction-cancellation-result.js";
import { memoryEffectInstant, rejectMemoryEffect, snapshotMemoryEffectValue } from "./second-brain-effect-v2-canonical.js";

const INVALID = "MEMORY_CANCELLATION_STATUS_INVALID";
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const base = z.object({ schema_version: z.literal(1), kind: z.literal("memory_correction_cancellation_status"),
  provider_instance_id: z.string(), intent_id: z.string(), intent_digest: digest,
  tombstone_sequence: z.number().int().safe().min(0), tombstone_set_root: digest });
const instant = z.iso.datetime({ precision: 3 });
const schema = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("not_found") }).strict(),
  base.extend({ state: z.literal("suppression_pending"), accepted_at: instant }).strict(),
  base.extend({ state: z.literal("provider_local_suppressed"), accepted_at: instant, result: z.unknown() }).strict(),
]);
export type CorrectionCancellationStatusV1 = Exclude<z.infer<typeof schema>, { state: "provider_local_suppressed" }>
  | (z.infer<typeof base> & { readonly state: "provider_local_suppressed"; readonly accepted_at: string;
    readonly result: CorrectionCancellationResultV1 });

/** Validate a status from the selected provider. Does not advance any local cursor. */
export function requireCorrectionCancellationStatus(value: unknown, intent: CorrectionCancellationIntentV1,
  options: { readonly now: Date; readonly provider_keys: ReadonlyMap<string, string | KeyObject>;
    readonly tombstone_sequence: number; readonly tombstone_set_root: string;
    readonly revoked_provider_key_ids?: ReadonlySet<string> }): CorrectionCancellationStatusV1 {
  const snapshot = snapshotMemoryEffectValue(value);
  if (Buffer.byteLength(canonicalize(snapshot)) > 32_768) rejectMemoryEffect(INVALID);
  const parsed = schema.safeParse(snapshot);
  if (!parsed.success) rejectMemoryEffect(INVALID);
  const status = parsed.data;
  if (status.provider_instance_id !== intent.provider_instance_id || status.intent_id !== intent.intent_id
    || status.intent_digest !== intent.intent_digest || status.tombstone_sequence !== options.tombstone_sequence
    || status.tombstone_set_root !== options.tombstone_set_root || !Number.isFinite(options.now.getTime())) rejectMemoryEffect(INVALID);
  if (status.state === "not_found") return Object.freeze(status);
  const accepted = memoryEffectInstant(status.accepted_at, INVALID);
  if (accepted < memoryEffectInstant(intent.not_before, INVALID) || accepted >= memoryEffectInstant(intent.expires_at, INVALID)
    || accepted > options.now.getTime() || status.tombstone_sequence < intent.tombstone.sequence
    || (status.tombstone_sequence === intent.tombstone.sequence && status.tombstone_set_root !== intent.tombstone.set_root)) rejectMemoryEffect(INVALID);
  if (status.state === "suppression_pending") return Object.freeze(status);
  const keys = new Map([...options.provider_keys].filter(([id]) => !options.revoked_provider_key_ids?.has(id)));
  const result = requireCorrectionCancellationResult(status.result, intent, { now: options.now, provider_keys: keys });
  if (result.accepted_at !== status.accepted_at) rejectMemoryEffect(INVALID);
  return Object.freeze({ ...status, result });
}
