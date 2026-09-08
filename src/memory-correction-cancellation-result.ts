import { createHash, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { CorrectionCancellationIntentV1 } from "./memory-correction-cancellation-intent.js";
import { memoryEffectInstant, rejectMemoryEffect, snapshotMemoryEffectValue,
  verifyMemoryEffectSignature, withoutMemoryEffectFields } from "./second-brain-effect-v2-canonical.js";

export const CORRECTION_CANCELLATION_RESULT_DOMAIN = "second-brain/memory-correction-cancellation-result/v1\0";
const INVALID = "MEMORY_CANCELLATION_RESULT_INVALID";
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const git = z.string().regex(/^[0-9a-f]{40}$/);
const instant = z.iso.datetime({ precision: 3 });
const schema = z.object({ schema_version: z.literal(1), kind: z.literal("memory_correction_cancellation_result"),
  state: z.literal("provider_local_suppressed"), disposition: z.literal("provider_local_suppression"),
  provider_instance_id: z.string(), provider_release_sha: git, signing_key_id: z.string().min(1).max(160),
  intent_id: z.string(), intent_digest: digest, original_request_id: z.string(), original_envelope_digest: digest,
  original_lane_id: z.string(), target_digest: digest, target_manifest_digest: digest, scope_digest: digest,
  base_generation_id: z.string(), result_generation_id: z.string(), result_generation_manifest_digest: digest,
  result_vault_head: git, result_vault_tree: git, tombstone_sequence: z.number().int().safe().min(1),
  tombstone_previous_root: digest, tombstone_set_root: digest, activation_manifest_digest: digest,
  reader_drain_digest: digest, predecessor_disposal_digest: digest, copy_checkpoint_digest: digest,
  generation_absence_digest: digest, aliases_digest: digest, alias_count: z.literal(8), reingress_digest: digest, accepted_at: instant,
  completed_at: instant, result_id: z.string().regex(/^memcancel:result:v1:[0-9a-f]{64}$/),
  result_digest: digest, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type CorrectionCancellationResultV1 = z.infer<typeof schema>;

/** Verify a provider-local historical result. Does not settle a cursor or prove native erasure. */
export function requireCorrectionCancellationResult(value: unknown, intent: CorrectionCancellationIntentV1,
  options: { readonly now: Date; readonly provider_keys: ReadonlyMap<string, string | KeyObject> }): CorrectionCancellationResultV1 {
  const snapshot = snapshotMemoryEffectValue(value);
  if (Buffer.byteLength(canonicalize(snapshot)) > 16_384) rejectMemoryEffect(INVALID);
  const parsed = schema.safeParse(snapshot);
  if (!parsed.success) rejectMemoryEffect(INVALID);
  const result = parsed.data; const old = intent.original_delegation; const t = intent.tombstone;
  const expected = { provider_instance_id: intent.provider_instance_id, intent_id: intent.intent_id,
    intent_digest: intent.intent_digest, original_request_id: old.request_id,
    original_envelope_digest: intent.original_envelope_digest, original_lane_id: old.lane_id,
    target_digest: intent.target.target_digest, target_manifest_digest: old.target_manifest_digest,
    scope_digest: old.scope_digest, base_generation_id: intent.target.generation_id,
    tombstone_sequence: t.sequence, tombstone_previous_root: t.previous_root, tombstone_set_root: t.set_root };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (Reflect.get(result, name) !== expectedValue) rejectMemoryEffect(INVALID);
  }
  const accepted = memoryEffectInstant(result.accepted_at, INVALID);
  const completed = memoryEffectInstant(result.completed_at, INVALID);
  const now = options.now.getTime();
  if (!Number.isFinite(now) || accepted < memoryEffectInstant(intent.not_before, INVALID)
    || accepted >= memoryEffectInstant(intent.expires_at, INVALID) || completed < accepted || completed > now
    || result.result_generation_id !== `sbgen:v1:${result.result_generation_manifest_digest.slice(7)}`
    || result.result_generation_id === result.base_generation_id
    || result.activation_manifest_digest !== result.result_generation_manifest_digest) rejectMemoryEffect(INVALID);
  const body = withoutMemoryEffectFields(result, ["result_id", "result_digest", "signature"]);
  const observed = `sha256:${createHash("sha256").update(CORRECTION_CANCELLATION_RESULT_DOMAIN).update(canonicalize(body)).digest("hex")}`;
  if (result.result_digest !== observed || result.result_id !== `memcancel:result:v1:${observed.slice(7)}`) rejectMemoryEffect(INVALID);
  verifyMemoryEffectSignature(options.provider_keys.get(result.signing_key_id), CORRECTION_CANCELLATION_RESULT_DOMAIN,
    withoutMemoryEffectFields(result, ["signature"]), result.signature, INVALID);
  return Object.freeze(result);
}
