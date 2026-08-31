import { sign, type KeyObject } from "node:crypto"; import { canonicalize } from "./canonical.js"; import { MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN,
  MEMORY_EFFECT_DIGEST, MEMORY_EFFECT_PURPOSE, MEMORY_READ_FENCE_SIGNATURE_DOMAIN, MemoryEffectValidationError, type MemoryEffectAcceptedV2,
  type MemoryEffectDelegationAuthorityV2, type MemoryEffectDelegationV2,
  type MemoryEffectSpecV2, type MemoryEffectWriteRequestV2, type MemoryReadFenceV1,
} from "./second-brain-effect-v2-contract.js"; import { assertExactMemoryEffectKeys, isMemoryEffectRecord, memoryEffectInstant, memoryEffectInteger,
  memoryEffectJsonDigest, memoryEffectMember, memoryEffectText, rejectMemoryEffect, snapshotMemoryEffectValue,
} from "./second-brain-effect-v2-canonical.js"; export { EXTERNAL_ERASURE_SIGNATURE_DOMAIN, MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN, MEMORY_EFFECT_DOMAINS,
  MEMORY_READ_FENCE_SIGNATURE_DOMAIN, MEMORY_TOMBSTONE_GENESIS_ROOT, MemoryEffectValidationError, } from "./second-brain-effect-v2-contract.js"; export type {
  ExternalErasureReceiptV2, MemoryCorrectionPayloadV2, MemoryDeletePayloadV2, MemoryEffectAcceptedV2, MemoryEffectDelegationAuthorityV2,
  MemoryEffectDelegationV2, MemoryEffectExpectedPriorV2, MemoryEffectLaneV2, MemoryEffectOperationV2, MemoryEffectPayloadV2, MemoryEffectScopeV2,
  MemoryEffectSpecV2, MemoryEffectValidationOptions, MemoryEffectWriteRequestV2, MemoryExportPayloadV2, MemoryReadFenceV1, MemorySensitivity,
  MemorySourceOwnerClass, MemoryTombstoneChainEntryV2, MemoryTombstoneHighWaterV2, ResolvedMemoryTargetV2, } from "./second-brain-effect-v2-contract.js";
export { memoryEffectDigest } from "./second-brain-effect-v2-canonical.js"; export { parseMemoryEffectWriteRequest, parseResolvedMemoryTarget,
  requireMemoryEffectWriteRequest, snapshotMemoryEffectWriteArguments, } from "./second-brain-effect-v2-validation.js";
export function createMemoryReadFence(input: Omit<MemoryReadFenceV1, "schema_version" | "fence_id" | "fence_digest" | "principal_id" | "signature">,
  privateKey: KeyObject): MemoryReadFenceV1 { const expectedOperation = { memory_read: "read", memory_status: "status", memory_resolve: "resolve" } as const;
  if (input.operation !== expectedOperation[input.purpose] || input.tombstone_sequence < 0
    || !Number.isSafeInteger(input.tombstone_sequence) || !MEMORY_EFFECT_DIGEST.test(input.tombstone_set_root)) rejectMemoryEffect("TOMBSTONE_FENCE_INVALID");
  const body = { schema_version: 1 as const, provider_instance_id: input.provider_instance_id, principal_id: "principal:owner" as const,
    purpose: input.purpose, operation: input.operation, tombstone_sequence: input.tombstone_sequence,
    tombstone_set_root: input.tombstone_set_root, issued_at: input.issued_at, not_before: input.not_before,
    expires_at: input.expires_at, nonce: input.nonce, signing_key_id: input.signing_key_id }; const observed = memoryEffectJsonDigest("read_fence", body);
  const unsigned = { ...body, fence_id: `memfence:v1:${observed.slice(7)}`, fence_digest: observed }; return { ...unsigned,
    signature: sign(null, Buffer.from(MEMORY_READ_FENCE_SIGNATURE_DOMAIN + canonicalize(unsigned)), privateKey).toString("base64url") }; }
export function createMemoryEffectWriteRequest(specification: MemoryEffectSpecV2,
  authority: MemoryEffectDelegationAuthorityV2, privateKey: KeyObject): MemoryEffectWriteRequestV2 {
  const spec = snapshotMemoryEffectValue(specification);
  if (!isMemoryEffectRecord(spec)) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  const requestDigest = memoryEffectJsonDigest("effect_spec", spec);
  const requestId = `memeff:req:v2:${requestDigest.slice(7)}`;
  const lane = specification.lane;
  const operation = specification.operation;
  const idempotencyDigest = memoryEffectJsonDigest("effect_idempotency", {
    lane, lane_id: specification.lane_id, operation, request_id: requestId,
    request_digest: requestDigest,
    target_manifest_digest: specification.target_manifest_digest,
    scope_digest: specification.scope_digest,
  });
  const payloadDigest = memoryEffectJsonDigest("effect_payload", specification.payload);
  const delegationBody: Omit<MemoryEffectDelegationV2,
    "delegation_id" | "delegation_digest" | "signature"> = {
    schema_version: 1, provider_instance_id: specification.provider_instance_id,
    purpose: MEMORY_EFFECT_PURPOSE[operation], operation, lane_id: specification.lane_id,
    request_id: requestId, request_digest: requestDigest, payload_digest: payloadDigest,
    target_manifest_digest: specification.target_manifest_digest,
    scope_digest: specification.scope_digest, expected_prior: specification.expected_prior,
    tombstone_sequence: specification.tombstone_high_water.sequence,
    tombstone_set_root: specification.tombstone_high_water.set_root,
    principal_id: authority.principal_id, issued_at: specification.created_at,
    not_before: authority.not_before, expires_at: specification.expires_at,
    nonce: authority.nonce, max_uses: 1, signing_key_id: authority.signing_key_id,
  };
  const delegationDigest = memoryEffectJsonDigest("delegation", delegationBody);
  const unsignedDelegation = {
    ...delegationBody,
    delegation_id: `memdeleg:v1:${delegationDigest.slice(7)}`,
    delegation_digest: delegationDigest,
  };
  const delegation: MemoryEffectDelegationV2 = {
    ...unsignedDelegation,
    signature: sign(null, Buffer.from(
      MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN + canonicalize(unsignedDelegation),
    ), privateKey).toString("base64url"),
  };
  const idempotencyKey = `memeff:idem:v2:${idempotencyDigest.slice(7)}`;
  const envelope = { ...spec, request_id: requestId, request_digest: requestDigest,
    idempotency_key: idempotencyKey, delegation };
  return Object.freeze({
    ...specification,
    request_id: requestId,
    request_digest: requestDigest,
    idempotency_key: idempotencyKey,
    envelope_digest: memoryEffectJsonDigest("envelope", envelope),
    delegation: Object.freeze(delegation),
  });
}
const ACCEPTED_KEYS = ["schema_version", "kind", "state", "request_id", "request_digest", "idempotency_key",
  "envelope_digest", "lane", "operation", "accepted_at", "queue_locator", "request_file_digest", "replayed",
  "capability_verified", "tombstone_sequence", "tombstone_set_root", "provider_instance_id"] as const;
export function parseMemoryEffectAccepted(value: unknown): MemoryEffectAcceptedV2 | undefined { try {
    const raw = snapshotMemoryEffectValue(value);
    if (!isMemoryEffectRecord(raw)) return undefined;
    assertExactMemoryEffectKeys(raw, ACCEPTED_KEYS, "EFFECT_RESULT_INVALID");
    if (raw.schema_version !== 2 || raw.kind !== "accepted" || raw.state !== "pending" || raw.capability_verified !== true
      || typeof raw.replayed !== "boolean" || !/^memeff:req:v2:[0-9a-f]{64}$/.test(memoryEffectText(raw, "request_id", "EFFECT_RESULT_INVALID"))
      || !/^memeff:idem:v2:[0-9a-f]{64}$/.test(memoryEffectText(raw, "idempotency_key", "EFFECT_RESULT_INVALID"))) return undefined;
    for (const key of ["request_digest", "envelope_digest", "request_file_digest", "tombstone_set_root"])
      if (!MEMORY_EFFECT_DIGEST.test(memoryEffectText(raw, key, "EFFECT_RESULT_INVALID"))) return undefined;
    const lane = memoryEffectMember(raw.lane,
      ["correction", "deletion", "export"] as const, "EFFECT_RESULT_INVALID");
    const operation = memoryEffectMember(raw.operation,
      ["correct", "forget", "export"] as const, "EFFECT_RESULT_INVALID");
    memoryEffectInstant(raw.accepted_at, "EFFECT_RESULT_INVALID");
    const tombstoneSequence = memoryEffectInteger(
      raw, "tombstone_sequence", "EFFECT_RESULT_INVALID",
    );
    if (tombstoneSequence < 0) return undefined;
    return Object.freeze({
      schema_version: 2, kind: "accepted", state: "pending",
      request_id: memoryEffectText(raw, "request_id", "EFFECT_RESULT_INVALID"),
      request_digest: memoryEffectText(raw, "request_digest", "EFFECT_RESULT_INVALID"),
      idempotency_key: memoryEffectText(raw, "idempotency_key", "EFFECT_RESULT_INVALID"),
      envelope_digest: memoryEffectText(raw, "envelope_digest", "EFFECT_RESULT_INVALID"),
      lane, operation,
      accepted_at: memoryEffectText(raw, "accepted_at", "EFFECT_RESULT_INVALID"),
      queue_locator: memoryEffectText(raw, "queue_locator", "EFFECT_RESULT_INVALID"),
      request_file_digest: memoryEffectText(raw, "request_file_digest", "EFFECT_RESULT_INVALID"),
      replayed: raw.replayed, capability_verified: true,
      tombstone_sequence: tombstoneSequence,
      tombstone_set_root: memoryEffectText(raw, "tombstone_set_root", "EFFECT_RESULT_INVALID"),
      provider_instance_id: memoryEffectText(raw, "provider_instance_id", "EFFECT_RESULT_INVALID"),
    });
  } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; } }
