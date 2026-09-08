import { createHash, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { MemoryEffectDelegationSchema, MemoryEffectScopeSchema,
  MemoryTombstoneChainEntrySchema, ResolvedMemoryTargetSchema } from "./memory-effect-write-zod.js";
import { memoryExpectedPrior } from "./memory-target-values.js";
import { memoryEffectDigest, parseResolvedMemoryTarget, requireMemoryEffectWriteRequest,
  MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN, type MemoryEffectWriteRequestV2,
  type MemoryEffectValidationOptions } from "./second-brain-effect-v2.js";
import { memoryEffectInstant, rejectMemoryEffect, snapshotMemoryEffectValue,
  verifyMemoryEffectSignature, withoutMemoryEffectFields } from "./second-brain-effect-v2-canonical.js";

export const CORRECTION_CANCELLATION_INTENT_DOMAIN = "orca-jarvis/memory-correction-cancellation-intent/v1\0";
export const MAX_CORRECTION_CANCELLATION_INTENT_BYTES = 16_384;
const INVALID = "MEMORY_CANCELLATION_INTENT_INVALID";
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const instant = z.iso.datetime({ precision: 3 });
const label = z.string().min(1).max(160);
const evidence = z.object({ candidate_id: z.string().regex(/^memcand:pos:v1:[0-9a-f]{64}$/),
  suppression_event_digest: digest, dispatch_fence: z.literal(0), attempt_count: z.literal(0),
  active_cursor: z.literal(false) }).strict();
const bodySchema = z.object({ schema_version: z.literal(1), kind: z.literal("memory_correction_cancellation_intent"),
  provider_instance_id: z.string().min(1).max(128), reason: z.literal("candidate_suppressed_unsent"),
  disposition: z.literal("provider_local_suppression"), original_envelope_digest: digest,
  original_idempotency_key: z.string().regex(/^memeff:idem:v2:[0-9a-f]{64}$/),
  original_delegation: MemoryEffectDelegationSchema, target: ResolvedMemoryTargetSchema,
  scope: MemoryEffectScopeSchema, tombstone: MemoryTombstoneChainEntrySchema, unsent_evidence: evidence,
  issued_at: instant, not_before: instant, expires_at: instant, nonce: label, signing_key_id: label }).strict();
const envelopeSchema = bodySchema.extend({ intent_id: z.string().regex(/^memcancel:intent:v1:[0-9a-f]{64}$/),
  intent_digest: digest, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type CorrectionCancellationIntentV1 = z.infer<typeof envelopeSchema>;
const sourceSchema = bodySchema.pick({ provider_instance_id: true, original_envelope_digest: true,
  original_idempotency_key: true, original_delegation: true, target: true, scope: true, tombstone: true }).strict();
export type CorrectionCancellationSource = z.infer<typeof sourceSchema>;
export function parseCorrectionCancellationSource(value: unknown): CorrectionCancellationSource {
  return freezeDeep(sourceSchema.parse(snapshotMemoryEffectValue(value)));
}
export type CorrectionCancellationEvidence = z.infer<typeof evidence>;
export type CorrectionCancellationIntentOptions = {
  readonly provider_instance_id: string; readonly now: Date;
  /** Historical verification keys; never infer current signing permission from this map. */
  readonly historical_delegation_keys: ReadonlyMap<string, string | KeyObject>;
  readonly current_cancellation_keys: ReadonlyMap<string, string | KeyObject>;
};

function intentDigest(body: unknown): string {
  return `sha256:${createHash("sha256").update(CORRECTION_CANCELLATION_INTENT_DOMAIN).update(canonicalize(body)).digest("hex")}`;
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Validates an attested intent only. Does not prove non-receipt, authorize execution or settle a lane. */
export function requireCorrectionCancellationIntent(value: unknown,
  options: CorrectionCancellationIntentOptions): CorrectionCancellationIntentV1 {
  const snapshot = snapshotMemoryEffectValue(value);
  if (Buffer.byteLength(canonicalize(snapshot)) > MAX_CORRECTION_CANCELLATION_INTENT_BYTES) rejectMemoryEffect(INVALID);
  const parsed = envelopeSchema.safeParse(snapshot);
  if (!parsed.success) rejectMemoryEffect(INVALID);
  const intent = parsed.data; const old = intent.original_delegation; const t = intent.tombstone;
  const issued = memoryEffectInstant(intent.issued_at, INVALID);
  const notBefore = memoryEffectInstant(intent.not_before, INVALID);
  const expires = memoryEffectInstant(intent.expires_at, INVALID); const now = options.now.getTime();
  const oldIssued = memoryEffectInstant(old.issued_at, INVALID);
  const oldNotBefore = memoryEffectInstant(old.not_before, INVALID);
  const oldExpires = memoryEffectInstant(old.expires_at, INVALID);
  const effective = memoryEffectInstant(t.effective_at, INVALID);
  if (!Number.isFinite(now) || issued > notBefore || notBefore > now || now >= expires
    || expires - issued > 300_000 || oldIssued > oldNotBefore || oldNotBefore >= oldExpires
    || oldExpires - oldIssued > 900_000 || oldNotBefore > issued || effective < oldIssued
    || effective >= oldExpires || effective > issued || intent.provider_instance_id !== options.provider_instance_id
    || old.provider_instance_id !== intent.provider_instance_id || old.purpose !== "memory_correction"
    || old.operation !== "correct" || !/^memcorr:req:v1:[0-9a-f]{64}$/.test(old.lane_id)
    || old.request_id !== `memeff:req:v2:${old.request_digest.slice(7)}`) rejectMemoryEffect(INVALID);
  const oldBody = withoutMemoryEffectFields(old, ["delegation_id", "delegation_digest", "signature"]);
  const oldDigest = memoryEffectDigest("delegation", oldBody);
  if (old.delegation_digest !== oldDigest || old.delegation_id !== `memdeleg:v1:${oldDigest.slice(7)}`) rejectMemoryEffect(INVALID);
  verifyMemoryEffectSignature(options.historical_delegation_keys.get(old.signing_key_id), MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN,
    withoutMemoryEffectFields(old, ["signature"]), old.signature, INVALID);
  const target = parseResolvedMemoryTarget(intent.target, intent.provider_instance_id, new Date(oldNotBefore));
  if (target === undefined || canonicalize(memoryExpectedPrior(target)) !== canonicalize(old.expected_prior)
    || memoryEffectDigest("target_manifest", { targets: [target] }) !== old.target_manifest_digest
    || memoryEffectDigest("target_scope", { target_digests: [target.target_digest], scope: intent.scope }) !== old.scope_digest) rejectMemoryEffect(INVALID);
  const scope = intent.scope;
  if (scope.format !== "none" || scope.max_records < 1 || scope.max_records > 64 || scope.max_bytes < 1 || scope.max_bytes > 1_048_576
    || !scope.sensitivity_classes.includes(target.sensitivity) || !scope.source_owner_classes.includes(target.source_owner_class)
    || canonicalize(scope.sensitivity_classes) !== canonicalize([...new Set(scope.sensitivity_classes)].sort())
    || canonicalize(scope.source_owner_classes) !== canonicalize([...new Set(scope.source_owner_classes)].sort())
    || Date.parse(scope.valid_from) >= Date.parse(scope.valid_until)
    || Date.parse(target.valid_from) < Date.parse(scope.valid_from)
    || Date.parse(target.valid_until) > Date.parse(scope.valid_until)) rejectMemoryEffect(INVALID);
  const root = memoryEffectDigest("tombstone_chain", withoutMemoryEffectFields(t, ["tombstone_id", "set_root"]));
  if (t.sequence < 1 || t.sequence !== old.tombstone_sequence || t.operation !== "correct" || t.lane_id !== old.lane_id
    || t.payload_digest !== old.payload_digest || t.target_manifest_digest !== old.target_manifest_digest || t.scope_digest !== old.scope_digest
    || t.set_root !== root || old.tombstone_set_root !== root || t.tombstone_id !== `memtomb:v1:${root.slice(7)}`) rejectMemoryEffect(INVALID);
  const idem = memoryEffectDigest("effect_idempotency", { lane: "correction", lane_id: old.lane_id, operation: "correct",
    request_id: old.request_id, request_digest: old.request_digest, target_manifest_digest: old.target_manifest_digest, scope_digest: old.scope_digest });
  if (intent.original_idempotency_key !== `memeff:idem:v2:${idem.slice(7)}`) rejectMemoryEffect(INVALID);
  const body = withoutMemoryEffectFields(intent, ["intent_id", "intent_digest", "signature"]);
  const observed = intentDigest(body);
  if (intent.intent_digest !== observed || intent.intent_id !== `memcancel:intent:v1:${observed.slice(7)}`) rejectMemoryEffect(INVALID);
  verifyMemoryEffectSignature(options.current_cancellation_keys.get(intent.signing_key_id), CORRECTION_CANCELLATION_INTENT_DOMAIN,
    withoutMemoryEffectFields(intent, ["signature"]), intent.signature, INVALID);
  return freezeDeep(intent);
}

/** Build metadata from an exact original request; unsent evidence still requires durable DB verification. */
export function createCorrectionCancellationIntent(original: MemoryEffectWriteRequestV2, attestation: CorrectionCancellationEvidence,
  authority: { readonly issued_at: string; readonly expires_at: string; readonly nonce: string; readonly signing_key_id: string },
  privateKey: KeyObject, options: CorrectionCancellationIntentOptions): CorrectionCancellationIntentV1 {
  const originalOptions: MemoryEffectValidationOptions = { now: new Date(original.delegation.not_before),
    expectedProvider: options.provider_instance_id, delegationKeys: options.historical_delegation_keys };
  const request = requireMemoryEffectWriteRequest(original, originalOptions);
  if (request.operation !== "correct" || request.targets.length !== 1 || request.tombstone_chain_delta.length !== 1) rejectMemoryEffect(INVALID);
  return createCorrectionCancellationFromSource({
    provider_instance_id: request.provider_instance_id,
    original_envelope_digest: request.envelope_digest, original_idempotency_key: request.idempotency_key,
    original_delegation: request.delegation, target: request.targets[0], scope: request.scope,
    tombstone: request.tombstone_chain_delta[0] }, attestation, authority, privateKey, options);
}

/** The caller must bind this metadata to its durable original request before issuing. */
export function createCorrectionCancellationFromSource(source: unknown, attestation: CorrectionCancellationEvidence,
  authority: { readonly issued_at: string; readonly expires_at: string; readonly nonce: string; readonly signing_key_id: string },
  privateKey: KeyObject, options: CorrectionCancellationIntentOptions): CorrectionCancellationIntentV1 {
  const metadata = sourceSchema.parse(snapshotMemoryEffectValue(source));
  const body = bodySchema.parse({ ...metadata, schema_version: 1, kind: "memory_correction_cancellation_intent",
    reason: "candidate_suppressed_unsent", disposition: "provider_local_suppression", unsent_evidence: attestation,
    ...authority, not_before: authority.issued_at });
  const observed = intentDigest(body);
  const unsigned = { ...body, intent_id: `memcancel:intent:v1:${observed.slice(7)}`, intent_digest: observed };
  return requireCorrectionCancellationIntent({ ...unsigned,
    signature: sign(null, Buffer.from(CORRECTION_CANCELLATION_INTENT_DOMAIN + canonicalize(unsigned)), privateKey).toString("base64url") }, options);
}
