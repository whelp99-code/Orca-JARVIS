import type { KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { EXTERNAL_ERASURE_SIGNATURE_DOMAIN, MEMORY_EFFECT_CHAIN_KEYS, MEMORY_EFFECT_DELEGATION_KEYS,
  MEMORY_EFFECT_DIGEST, MEMORY_EFFECT_HMAC, MEMORY_EFFECT_HEX40, MEMORY_EFFECT_HEX64, MEMORY_EFFECT_LANE_OPERATION, MEMORY_EFFECT_LANE_PREFIX,
  MEMORY_EFFECT_OWNER_CLASSES, MEMORY_EFFECT_PRIOR_KEYS, MEMORY_EFFECT_PURPOSE, MEMORY_EFFECT_ROOT_KEYS, MEMORY_EFFECT_SCOPE_KEYS, MEMORY_EFFECT_SENSITIVITIES,
  MEMORY_EFFECT_TARGET_KEYS, MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN, MemoryEffectValidationError, type ExternalErasureReceiptV2,
  type MemoryCorrectionPayloadV2, type MemoryDeletePayloadV2, type MemoryEffectExpectedPriorV2, type MemoryEffectOperationV2, type MemoryEffectPayloadV2,
  type MemoryEffectDelegationV2, type MemoryEffectScopeV2, type MemoryEffectValidationOptions,
  type MemoryEffectWriteRequestV2, type MemoryExportPayloadV2, type MemoryTombstoneChainEntryV2,
  type MemoryTombstoneHighWaterV2, type ResolvedMemoryTargetV2, } from "./second-brain-effect-v2-contract.js"; import { assertExactMemoryEffectKeys,
  isMemoryEffectRecord, memoryEffectInstant, memoryEffectInteger, memoryEffectJsonDigest, memoryEffectMember, memoryEffectText, rejectMemoryEffect,
  snapshotMemoryEffectValue, verifyMemoryEffectSignature, withoutMemoryEffectFields, } from "./second-brain-effect-v2-canonical.js";
function validateTarget(value: unknown, provider: string, nowMs: number): ResolvedMemoryTargetV2 {
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  assertExactMemoryEffectKeys(value, MEMORY_EFFECT_TARGET_KEYS, "EFFECT_TARGET_INVALID");
  if (value.schema_version !== 1 || value.provider_instance_id !== provider) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  const core = withoutMemoryEffectFields(value, ["target_id", "target_digest"]); const observed = memoryEffectJsonDigest("target", core);
  if (value.target_digest !== observed || value.target_id !== `sbtarget:v1:${observed.slice(7)}`) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  for (const key of ["source_identity_full", "content_identity_full", "citation_identity_full"])
    if (!MEMORY_EFFECT_HEX64.test(memoryEffectText(value, key, "EFFECT_TARGET_INVALID"))) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  for (const key of ["generation_manifest_digest", "page_content_digest", "subject_digest", "source_owner_id_digest"])
    if (!MEMORY_EFFECT_DIGEST.test(memoryEffectText(value, key, "EFFECT_TARGET_INVALID"))) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  for (const key of ["vault_head", "vault_tree", "page_blob_oid"])
    if (!MEMORY_EFFECT_HEX40.test(memoryEffectText(value, key, "EFFECT_TARGET_INVALID"))) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  memoryEffectMember(value.sensitivity, MEMORY_EFFECT_SENSITIVITIES, "EFFECT_TARGET_INVALID");
  memoryEffectMember(value.source_owner_class, MEMORY_EFFECT_OWNER_CLASSES, "EFFECT_TARGET_INVALID");
  const start = memoryEffectInteger(value, "citation_span_start", "EFFECT_TARGET_INVALID");
  const end = memoryEffectInteger(value, "citation_span_end", "EFFECT_TARGET_INVALID");
  const validFrom = memoryEffectInstant(value.valid_from, "EFFECT_TARGET_INVALID");
  const validUntil = memoryEffectInstant(value.valid_until, "EFFECT_TARGET_INVALID");
  const resolved = memoryEffectInstant(value.resolved_at, "EFFECT_TARGET_INVALID");
  const expires = memoryEffectInstant(value.expires_at, "EFFECT_TARGET_INVALID");
  if (start < 0 || start >= end || validFrom >= validUntil || resolved >= expires || expires <= nowMs
    || Buffer.byteLength(canonicalize(value), "utf8") > 16_384) rejectMemoryEffect("EFFECT_TARGET_INVALID"); return value as ResolvedMemoryTargetV2; }
export function parseResolvedMemoryTarget(value: unknown, provider: string, now: Date): ResolvedMemoryTargetV2 | undefined { try {
    const raw = snapshotMemoryEffectValue(value); const nowMs = now.getTime(); if (!Number.isFinite(nowMs)) return undefined;
    return Object.freeze(validateTarget(raw, provider, nowMs));
  } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; } }
function validatePrior(value: unknown, targets: readonly ResolvedMemoryTargetV2[]): MemoryEffectExpectedPriorV2 {
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EFFECT_PRIOR_STALE");
  assertExactMemoryEffectKeys(value, MEMORY_EFFECT_PRIOR_KEYS, "EFFECT_PRIOR_STALE");
  const first = targets[0]; if (first === undefined) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  for (const key of ["provider_instance_id", "generation_id", "generation_manifest_digest", "vault_head", "vault_tree"] as const) {
    if (targets.some(target => target[key] !== value[key])) rejectMemoryEffect("EFFECT_PRIOR_STALE"); }
  if (value.page_blob_oid !== first.page_blob_oid || value.page_content_digest !== first.page_content_digest
    || value.citation_identity_full !== first.citation_identity_full) rejectMemoryEffect("EFFECT_PRIOR_STALE"); return value as MemoryEffectExpectedPriorV2; }
function stringArray(value: unknown, allowed: readonly string[], code: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !allowed.includes(item))) rejectMemoryEffect(code);
  if (value.join("\0") !== [...new Set(value)].sort().join("\0")) rejectMemoryEffect(code); return value as string[]; }
function validateScope(value: unknown, targets: readonly ResolvedMemoryTargetV2[], operation: MemoryEffectOperationV2): MemoryEffectScopeV2 {
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EFFECT_SCOPE_INVALID");
  assertExactMemoryEffectKeys(value, MEMORY_EFFECT_SCOPE_KEYS, "EFFECT_SCOPE_INVALID");
  const format = memoryEffectMember(value.format, ["none", "json"] as const, "EFFECT_SCOPE_INVALID");
  const sensitivities = stringArray(value.sensitivity_classes, MEMORY_EFFECT_SENSITIVITIES, "EFFECT_SCOPE_INVALID");
  const owners = stringArray(value.source_owner_classes, MEMORY_EFFECT_OWNER_CLASSES, "EFFECT_SCOPE_INVALID");
  const maxRecords = memoryEffectInteger(value, "max_records", "EFFECT_SCOPE_INVALID");
  const maxBytes = memoryEffectInteger(value, "max_bytes", "EFFECT_SCOPE_INVALID");
  const from = memoryEffectInstant(value.valid_from, "EFFECT_SCOPE_INVALID"); const until = memoryEffectInstant(value.valid_until, "EFFECT_SCOPE_INVALID");
  if (sensitivities.length === 0 || owners.length === 0 || maxRecords < targets.length || maxRecords < 1 || maxRecords > 64
    || maxBytes < 1 || maxBytes > 1_048_576 || from >= until
    || format !== (operation === "export" ? "json" : "none")) rejectMemoryEffect("EFFECT_SCOPE_INVALID");
  if (targets.some(target => !sensitivities.includes(target.sensitivity) || !owners.includes(target.source_owner_class)
    || Date.parse(target.valid_from) < from || Date.parse(target.valid_until) > until)) rejectMemoryEffect("EFFECT_SCOPE_INVALID");
  return value as MemoryEffectScopeV2; } function validateExternalReceipt(value: unknown, requestScope: string, externalOwners: ReadonlySet<string>,
  keys: ReadonlyMap<string, string | KeyObject> | undefined): ExternalErasureReceiptV2 {
  const fields = ["owner_id_digest", "receipt_id", "receipt_digest", "scope_digest", "deleted_at", "signing_key_id", "signature"];
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EXTERNAL_RECEIPT_INVALID"); assertExactMemoryEffectKeys(value, fields, "EXTERNAL_RECEIPT_INVALID");
  const body = withoutMemoryEffectFields(value, ["receipt_id", "receipt_digest", "signature"]);
  const observed = memoryEffectJsonDigest("external_receipt", body);
  const owner = memoryEffectText(value, "owner_id_digest", "EXTERNAL_RECEIPT_INVALID");
  const signingKey = memoryEffectText(value, "signing_key_id", "EXTERNAL_RECEIPT_INVALID");
  if (value.receipt_digest !== observed || value.receipt_id !== `exterase:v1:${observed.slice(7)}`
    || value.scope_digest !== requestScope || !externalOwners.has(owner)
    || Buffer.byteLength(canonicalize(value)) > 2_048) rejectMemoryEffect("EXTERNAL_RECEIPT_INVALID");
  memoryEffectInstant(value.deleted_at, "EXTERNAL_RECEIPT_INVALID");
  verifyMemoryEffectSignature(keys?.get(signingKey), EXTERNAL_ERASURE_SIGNATURE_DOMAIN,
    withoutMemoryEffectFields(value, ["signature"]), value.signature, "EXTERNAL_RECEIPT_INVALID");
  return value as ExternalErasureReceiptV2; } function validatePayload(value: unknown, operation: MemoryEffectOperationV2, scope: MemoryEffectScopeV2,
  targets: readonly ResolvedMemoryTargetV2[], scopeDigest: string, externalKeys: ReadonlyMap<string, string | KeyObject> | undefined): MemoryEffectPayloadV2 {
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EFFECT_PAYLOAD_INVALID"); if (operation === "correct") {
    assertExactMemoryEffectKeys(value, ["content", "content_digest", "content_bytes", "disposition"], "EFFECT_PAYLOAD_INVALID");
    const content = memoryEffectText(value, "content", "EFFECT_PAYLOAD_INVALID"); const bytes = Buffer.byteLength(content, "utf8");
    if (content !== content.trim() || bytes < 1 || bytes > 4_096 || value.content_bytes !== bytes
      || value.content_digest !== memoryEffectJsonDigest("effect_content", { content })
      || value.disposition !== "superseded") rejectMemoryEffect("EFFECT_PAYLOAD_INVALID");
    return value as MemoryCorrectionPayloadV2; } if (operation === "forget") {
    assertExactMemoryEffectKeys(value, ["disposition", "erasure_claim", "external_receipts"], "EFFECT_PAYLOAD_INVALID");
    if (value.disposition !== "owner_requested" || !["managed_erasure", "provider_local_suppression"].includes(String(value.erasure_claim))
      || !Array.isArray(value.external_receipts) || value.external_receipts.length > 16) rejectMemoryEffect("EFFECT_PAYLOAD_INVALID");
    const externalOwners = new Set(targets.filter(target => target.source_owner_class === "external_read_only").map(target => target.source_owner_id_digest));
    if (value.erasure_claim === "managed_erasure" && externalOwners.size > 0) rejectMemoryEffect("MANAGED_ERASURE_SCOPE_INVALID");
    const receiptOwners = new Set(value.external_receipts.map(receipt =>
      validateExternalReceipt(receipt, scopeDigest, externalOwners, externalKeys).owner_id_digest));
    if (externalOwners.size > 0 && (receiptOwners.size !== externalOwners.size
      || [...externalOwners].some(owner => !receiptOwners.has(owner)))) rejectMemoryEffect("EXTERNAL_RECEIPT_INVALID"); return value as MemoryDeletePayloadV2; }
  assertExactMemoryEffectKeys(value, ["format", "target_record_ids", "sensitivity_classes",
    "valid_from", "valid_until", "max_records", "max_bytes"], "EFFECT_PAYLOAD_INVALID");
  if (value.format !== "json" || !Array.isArray(value.target_record_ids)
    || value.target_record_ids.join("\0") !== targets.map(target => target.target_id).join("\0")
    || !Array.isArray(value.sensitivity_classes) || value.sensitivity_classes.join("\0") !== scope.sensitivity_classes.join("\0")
    || value.valid_from !== scope.valid_from || value.valid_until !== scope.valid_until
    || value.max_records !== scope.max_records || value.max_bytes !== scope.max_bytes) rejectMemoryEffect("EXPORT_SCOPE_AMBIGUOUS");
  return value as MemoryExportPayloadV2; } function validateChain(value: unknown, highValue: unknown, operation: MemoryEffectOperationV2, laneId: string,
  targetManifest: string, scopeDigest: string, payloadDigest: string): { high: MemoryTombstoneHighWaterV2; delta: readonly MemoryTombstoneChainEntryV2[] } {
  if (!isMemoryEffectRecord(highValue)) rejectMemoryEffect("EFFECT_TOMBSTONE_DELTA_INVALID");
  assertExactMemoryEffectKeys(highValue, ["sequence", "set_root"], "EFFECT_TOMBSTONE_DELTA_INVALID");
  const highSequence = memoryEffectInteger(highValue, "sequence", "EFFECT_TOMBSTONE_DELTA_INVALID");
  if (highSequence < 0 || !MEMORY_EFFECT_DIGEST.test(memoryEffectText(highValue, "set_root", "EFFECT_TOMBSTONE_DELTA_INVALID")) || !Array.isArray(value)
    || value.length > 256 || (operation !== "export" && value.length === 0)) rejectMemoryEffect("EFFECT_TOMBSTONE_DELTA_INVALID");
  let priorSequence: number | undefined; let priorRoot: string | undefined; const seen = new Set<string>(); const delta = value.map(raw => {
    if (!isMemoryEffectRecord(raw)) rejectMemoryEffect("EFFECT_TOMBSTONE_DELTA_INVALID");
    assertExactMemoryEffectKeys(raw, MEMORY_EFFECT_CHAIN_KEYS, "EFFECT_TOMBSTONE_DELTA_INVALID");
    const sequence = memoryEffectInteger(raw, "sequence", "EFFECT_TOMBSTONE_DELTA_INVALID");
    const root = memoryEffectText(raw, "set_root", "EFFECT_TOMBSTONE_DELTA_INVALID");
    const id = memoryEffectText(raw, "tombstone_id", "EFFECT_TOMBSTONE_DELTA_INVALID");
    const core = withoutMemoryEffectFields(raw, ["tombstone_id", "set_root"]);
    const observed = memoryEffectJsonDigest("tombstone_chain", core);
    if ((priorSequence !== undefined && sequence !== priorSequence + 1) || (priorRoot !== undefined && raw.previous_root !== priorRoot)
      || seen.has(id) || root !== observed || id !== `memtomb:v1:${observed.slice(7)}` || raw.operation !== operation
      || raw.lane_id !== laneId || raw.target_manifest_digest !== targetManifest || raw.scope_digest !== scopeDigest
      || raw.payload_digest !== payloadDigest || !MEMORY_EFFECT_HMAC.test(memoryEffectText(raw, "keyed_subject_digest", "EFFECT_TOMBSTONE_DELTA_INVALID"))
      || !MEMORY_EFFECT_DIGEST.test(memoryEffectText(
        raw, "authority_receipt_digest", "EFFECT_TOMBSTONE_DELTA_INVALID",
      ))) rejectMemoryEffect("EFFECT_TOMBSTONE_DELTA_INVALID");
    memoryEffectInstant(raw.effective_at, "EFFECT_TOMBSTONE_DELTA_INVALID");
    priorSequence = sequence; priorRoot = root; seen.add(id); return raw as MemoryTombstoneChainEntryV2; }); const last = delta.at(-1);
  if (last !== undefined && (last.sequence !== highSequence || last.set_root !== highValue.set_root)) rejectMemoryEffect("EFFECT_TOMBSTONE_DELTA_INVALID");
  return { high: highValue as MemoryTombstoneHighWaterV2, delta }; }
export function requireMemoryEffectWriteRequest(value: unknown, options: MemoryEffectValidationOptions): MemoryEffectWriteRequestV2 {
  const raw = snapshotMemoryEffectValue(value); if (!isMemoryEffectRecord(raw)) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  const bytes = Buffer.byteLength(canonicalize(raw), "utf8"); if (bytes > 262_144) rejectMemoryEffect("EFFECT_REQUEST_OVERSIZE");
  assertExactMemoryEffectKeys(raw, MEMORY_EFFECT_ROOT_KEYS);
  if (raw.schema_version !== 2 || raw.kind !== "memory_effect") rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  const provider = memoryEffectText(raw, "provider_instance_id", "EFFECT_IDENTITY_INVALID");
  if (options.expectedProvider !== undefined && provider !== options.expectedProvider) rejectMemoryEffect("EFFECT_IDENTITY_INVALID");
  const lane = memoryEffectMember(raw.lane, ["correction", "deletion", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const operation = memoryEffectMember(raw.operation, ["correct", "forget", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const laneId = memoryEffectText(raw, "lane_id", "EFFECT_IDENTITY_INVALID");
  if (MEMORY_EFFECT_LANE_OPERATION[lane] !== operation
    || !new RegExp(`^${MEMORY_EFFECT_LANE_PREFIX[lane]}[0-9a-f]{64}$`).test(laneId)) {
    rejectMemoryEffect("EFFECT_OPERATION_CONFUSION");
  }
  const nowMs = options.now.getTime(); if (!Number.isFinite(nowMs)) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  const created = memoryEffectInstant(raw.created_at, "EFFECT_REQUEST_INVALID"); const expires = memoryEffectInstant(raw.expires_at, "EFFECT_REQUEST_INVALID");
  if (created > nowMs || nowMs >= expires || expires <= created || expires - created > 15 * 60_000) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 64) rejectMemoryEffect("EFFECT_TARGET_INVALID");
  const targets = raw.targets.map(target => validateTarget(target, provider, nowMs)); const targetDigests = targets.map(target => target.target_digest);
  if (targetDigests.join("\0") !== [...new Set(targetDigests)].sort().join("\0")) rejectMemoryEffect("EFFECT_TARGET_AMBIGUOUS");
  const targetManifest = memoryEffectJsonDigest("target_manifest", { targets });
  if (raw.target_manifest_digest !== targetManifest) rejectMemoryEffect("EFFECT_TARGET_INVALID"); const scope = validateScope(raw.scope, targets, operation);
  const scopeDigest = memoryEffectJsonDigest("target_scope", { target_digests: targetDigests, scope });
  if (raw.scope_digest !== scopeDigest) rejectMemoryEffect("EFFECT_SCOPE_INVALID"); const prior = validatePrior(raw.expected_prior, targets);
  const payload = validatePayload(raw.payload, operation, scope, targets, scopeDigest, options.externalReceiptKeys);
  const payloadDigest = memoryEffectJsonDigest("effect_payload", payload);
  const chain = validateChain(raw.tombstone_chain_delta, raw.tombstone_high_water, operation, laneId, targetManifest, scopeDigest, payloadDigest);
  const spec = withoutMemoryEffectFields(raw, ["request_id", "request_digest", "idempotency_key", "delegation", "envelope_digest"]);
  if (Buffer.byteLength(canonicalize(spec), "utf8") > 196_608) rejectMemoryEffect("EFFECT_REQUEST_OVERSIZE");
  const requestDigest = memoryEffectJsonDigest("effect_spec", spec); const requestId = `memeff:req:v2:${requestDigest.slice(7)}`;
  if (raw.request_digest !== requestDigest) rejectMemoryEffect("EFFECT_SPEC_DIGEST_INVALID");
  if (raw.request_id !== requestId) rejectMemoryEffect("EFFECT_IDENTITY_INVALID");
  const idem = memoryEffectJsonDigest("effect_idempotency", { lane, lane_id: laneId, operation, request_id: requestId,
    request_digest: requestDigest, target_manifest_digest: targetManifest, scope_digest: scopeDigest });
  if (raw.idempotency_key !== `memeff:idem:v2:${idem.slice(7)}`) rejectMemoryEffect("EFFECT_IDEMPOTENCY_INVALID");
  if (!isMemoryEffectRecord(raw.delegation)) rejectMemoryEffect("EFFECT_DELEGATION_INVALID"); const delegation = raw.delegation;
  assertExactMemoryEffectKeys(delegation, MEMORY_EFFECT_DELEGATION_KEYS, "EFFECT_DELEGATION_INVALID");
  const delegationBody = withoutMemoryEffectFields(delegation, ["delegation_id", "delegation_digest", "signature"]);
  const delegationDigest = memoryEffectJsonDigest("delegation", delegationBody);
  const signingKey = memoryEffectText(delegation, "signing_key_id", "EFFECT_DELEGATION_INVALID");
  const delegationIssued = memoryEffectInstant(delegation.issued_at, "EFFECT_DELEGATION_INVALID");
  const delegationNotBefore = memoryEffectInstant(delegation.not_before, "EFFECT_DELEGATION_INVALID");
  const delegationExpires = memoryEffectInstant(delegation.expires_at, "EFFECT_DELEGATION_INVALID");
  if (delegation.schema_version !== 1 || delegation.delegation_digest !== delegationDigest
    || delegation.delegation_id !== `memdeleg:v1:${delegationDigest.slice(7)}` || delegation.provider_instance_id !== provider
    || delegation.purpose !== MEMORY_EFFECT_PURPOSE[operation] || delegation.operation !== operation || delegation.lane_id !== laneId
    || delegation.request_id !== requestId || delegation.request_digest !== requestDigest || delegation.payload_digest !== payloadDigest
    || delegation.target_manifest_digest !== targetManifest || delegation.scope_digest !== scopeDigest
    || canonicalize(delegation.expected_prior) !== canonicalize(prior) || delegation.tombstone_sequence !== chain.high.sequence
    || delegation.tombstone_set_root !== chain.high.set_root || delegation.principal_id !== "principal:owner"
    || delegation.issued_at !== raw.created_at || delegation.expires_at !== raw.expires_at || delegation.max_uses !== 1
    || delegationIssued > delegationNotBefore || delegationNotBefore > nowMs || nowMs >= delegationExpires) rejectMemoryEffect("EFFECT_DELEGATION_INVALID");
  verifyMemoryEffectSignature(options.delegationKeys.get(signingKey), MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN,
    withoutMemoryEffectFields(delegation, ["signature"]), delegation.signature, "EFFECT_DELEGATION_INVALID");
  const envelope = withoutMemoryEffectFields(raw, ["envelope_digest"]);
  if (raw.envelope_digest !== memoryEffectJsonDigest("envelope", envelope)) {
    rejectMemoryEffect("EFFECT_ENVELOPE_DIGEST_INVALID");
  }
  const verifiedDelegation: MemoryEffectDelegationV2 = Object.freeze({
    schema_version: 1,
    delegation_id: memoryEffectText(delegation, "delegation_id", "EFFECT_DELEGATION_INVALID"),
    delegation_digest: delegationDigest,
    provider_instance_id: provider,
    purpose: MEMORY_EFFECT_PURPOSE[operation], operation, lane_id: laneId,
    request_id: requestId, request_digest: requestDigest, payload_digest: payloadDigest,
    target_manifest_digest: targetManifest, scope_digest: scopeDigest,
    expected_prior: Object.freeze(prior), tombstone_sequence: chain.high.sequence,
    tombstone_set_root: chain.high.set_root, principal_id: "principal:owner",
    issued_at: memoryEffectText(delegation, "issued_at", "EFFECT_DELEGATION_INVALID"),
    not_before: memoryEffectText(delegation, "not_before", "EFFECT_DELEGATION_INVALID"),
    expires_at: memoryEffectText(delegation, "expires_at", "EFFECT_DELEGATION_INVALID"),
    nonce: memoryEffectText(delegation, "nonce", "EFFECT_DELEGATION_INVALID"),
    max_uses: 1, signing_key_id: signingKey,
    signature: memoryEffectText(delegation, "signature", "EFFECT_DELEGATION_INVALID"),
  });
  return Object.freeze({
    schema_version: 2, kind: "memory_effect", provider_instance_id: provider,
    lane, lane_id: laneId, operation, request_id: requestId, request_digest: requestDigest,
    idempotency_key: memoryEffectText(raw, "idempotency_key", "EFFECT_IDEMPOTENCY_INVALID"),
    envelope_digest: memoryEffectText(raw, "envelope_digest", "EFFECT_ENVELOPE_DIGEST_INVALID"),
    target_manifest_digest: targetManifest, targets: Object.freeze(targets),
    scope: Object.freeze(scope), scope_digest: scopeDigest,
    expected_prior: Object.freeze(prior), tombstone_high_water: Object.freeze(chain.high),
    tombstone_chain_delta: Object.freeze(chain.delta), delegation: verifiedDelegation,
    created_at: memoryEffectText(raw, "created_at", "EFFECT_REQUEST_INVALID"),
    expires_at: memoryEffectText(raw, "expires_at", "EFFECT_REQUEST_INVALID"),
    payload: Object.freeze(payload),
  });
}
export function parseMemoryEffectWriteRequest(value: unknown, options: MemoryEffectValidationOptions): MemoryEffectWriteRequestV2 | undefined {
  try { return requireMemoryEffectWriteRequest(value, options); } catch (error) {
    if (error instanceof MemoryEffectValidationError) return undefined; throw error; } }
export function snapshotMemoryEffectWriteArguments(value: unknown): Readonly<Record<string, unknown>> | undefined { try {
    const raw = snapshotMemoryEffectValue(value); if (!isMemoryEffectRecord(raw)) return undefined;
    assertExactMemoryEffectKeys(raw, ["request"]); const request = raw.request;
    if (!isMemoryEffectRecord(request)) return undefined; assertExactMemoryEffectKeys(request, MEMORY_EFFECT_ROOT_KEYS);
    if (request.schema_version !== 2 || request.kind !== "memory_effect" || Buffer.byteLength(canonicalize(request), "utf8") > 262_144) return undefined;
    return Object.freeze(raw); } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; } }
