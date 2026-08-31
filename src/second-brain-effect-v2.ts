import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalize } from "./canonical.js";

export const MEMORY_EFFECT_DOMAINS = Object.freeze({
  target: "second-brain/memory-target/v1\0",
  target_manifest: "second-brain/memory-target-manifest/v1\0",
  target_scope: "second-brain/memory-target-scope/v1\0",
  effect_content: "orca-jarvis/memory-effect-content/v2\0",
  effect_payload: "orca-jarvis/memory-effect-payload/v2\0",
  tombstone_chain: "orca-jarvis/memory-tombstone-chain/v1\0",
  effect_spec: "orca-jarvis/memory-effect-spec/v2\0",
  effect_idempotency: "orca-jarvis/memory-effect-idempotency/v2\0",
  delegation: "orca-jarvis/memory-effect-delegation/v1\0",
  delegation_revocation: "orca-jarvis/memory-effect-delegation-revocation/v1\0",
  envelope: "orca-jarvis/memory-effect-envelope/v2\0",
  request_file: "second-brain/memory-effect-request-file/v2\0",
  read_fence: "orca-jarvis/memory-read-fence/v1\0",
  external_receipt: "external-owner/memory-erasure-receipt/v1\0",
});
export const MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN = "orca-jarvis/memory-effect-delegation/v1\0";
export const EXTERNAL_ERASURE_SIGNATURE_DOMAIN = "external-owner/memory-erasure-receipt/v1\0";
export const MEMORY_READ_FENCE_SIGNATURE_DOMAIN = "orca-jarvis/memory-read-fence/v1\0";
export const MEMORY_TOMBSTONE_GENESIS_ROOT = "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3";

export type MemoryEffectOperationV2 = "correct" | "forget" | "export";
export type MemoryEffectLaneV2 = "correction" | "deletion" | "export";
export type MemorySensitivity = "public" | "personal" | "sensitive" | "restricted";
export type MemorySourceOwnerClass = "provider_owned" | "external_read_only";
export type ResolvedMemoryTargetV2 = {
  readonly schema_version: 1; readonly target_id: string; readonly target_digest: string;
  readonly provider_instance_id: string; readonly generation_id: string; readonly generation_manifest_digest: string;
  readonly vault_head: string; readonly vault_tree: string; readonly page_id: string; readonly page_blob_oid: string;
  readonly page_content_digest: string; readonly source_identity_full: string; readonly content_identity_full: string;
  readonly citation_identity_full: string; readonly citation_span_start: number; readonly citation_span_end: number;
  readonly subject_digest: string; readonly sensitivity: MemorySensitivity; readonly valid_from: string;
  readonly valid_until: string; readonly source_owner_class: MemorySourceOwnerClass;
  readonly source_owner_id_digest: string; readonly resolved_at: string; readonly expires_at: string;
};
export type MemoryEffectExpectedPriorV2 = {
  readonly provider_instance_id: string; readonly generation_id: string; readonly generation_manifest_digest: string;
  readonly vault_head: string; readonly vault_tree: string; readonly page_blob_oid: string;
  readonly page_content_digest: string; readonly citation_identity_full: string;
};
export type MemoryEffectScopeV2 = {
  readonly format: "none" | "json"; readonly sensitivity_classes: readonly MemorySensitivity[];
  readonly valid_from: string; readonly valid_until: string; readonly max_records: number; readonly max_bytes: number;
  readonly source_owner_classes: readonly MemorySourceOwnerClass[];
};
export type MemoryTombstoneHighWaterV2 = { readonly sequence: number; readonly set_root: string };
export type MemoryTombstoneChainEntryV2 = {
  readonly sequence: number; readonly tombstone_id: string; readonly operation: "correct" | "forget";
  readonly lane_id: string; readonly target_manifest_digest: string; readonly scope_digest: string;
  readonly authority_receipt_digest: string; readonly payload_digest: string; readonly keyed_subject_digest: string;
  readonly effective_at: string; readonly previous_root: string; readonly set_root: string;
};
export type ExternalErasureReceiptV2 = {
  readonly owner_id_digest: string; readonly receipt_id: string; readonly receipt_digest: string;
  readonly scope_digest: string; readonly deleted_at: string; readonly signing_key_id: string; readonly signature: string;
};
export type MemoryCorrectionPayloadV2 = {
  readonly content: string; readonly content_digest: string; readonly content_bytes: number;
  readonly disposition: "superseded";
};
export type MemoryDeletePayloadV2 = {
  readonly disposition: "owner_requested"; readonly erasure_claim: "managed_erasure" | "provider_local_suppression";
  readonly external_receipts: readonly ExternalErasureReceiptV2[];
};
export type MemoryExportPayloadV2 = {
  readonly format: "json"; readonly target_record_ids: readonly string[];
  readonly sensitivity_classes: readonly MemorySensitivity[]; readonly valid_from: string; readonly valid_until: string;
  readonly max_records: number; readonly max_bytes: number;
};
export type MemoryEffectPayloadV2 = MemoryCorrectionPayloadV2 | MemoryDeletePayloadV2 | MemoryExportPayloadV2;
export type MemoryEffectDelegationV2 = {
  readonly schema_version: 1; readonly delegation_id: string; readonly delegation_digest: string;
  readonly provider_instance_id: string; readonly purpose: "memory_correction" | "memory_delete" | "memory_export";
  readonly operation: MemoryEffectOperationV2; readonly lane_id: string; readonly request_id: string;
  readonly request_digest: string; readonly payload_digest: string; readonly target_manifest_digest: string;
  readonly scope_digest: string; readonly expected_prior: MemoryEffectExpectedPriorV2;
  readonly tombstone_sequence: number; readonly tombstone_set_root: string; readonly principal_id: "principal:owner";
  readonly issued_at: string; readonly not_before: string; readonly expires_at: string; readonly nonce: string;
  readonly max_uses: 1; readonly signing_key_id: string; readonly signature: string;
};
export type MemoryEffectWriteRequestV2 = {
  readonly schema_version: 2; readonly kind: "memory_effect"; readonly provider_instance_id: string;
  readonly lane: MemoryEffectLaneV2; readonly lane_id: string; readonly operation: MemoryEffectOperationV2;
  readonly request_id: string; readonly request_digest: string; readonly idempotency_key: string;
  readonly envelope_digest: string; readonly target_manifest_digest: string;
  readonly targets: readonly ResolvedMemoryTargetV2[]; readonly scope: MemoryEffectScopeV2;
  readonly scope_digest: string; readonly expected_prior: MemoryEffectExpectedPriorV2;
  readonly tombstone_high_water: MemoryTombstoneHighWaterV2;
  readonly tombstone_chain_delta: readonly MemoryTombstoneChainEntryV2[];
  readonly delegation: MemoryEffectDelegationV2; readonly created_at: string; readonly expires_at: string;
  readonly payload: MemoryEffectPayloadV2;
};
export type MemoryReadFenceV1 = {
  readonly schema_version: 1; readonly fence_id: string; readonly fence_digest: string;
  readonly provider_instance_id: string; readonly principal_id: "principal:owner";
  readonly purpose: "memory_read" | "memory_status" | "memory_resolve";
  readonly operation: "read" | "status" | "resolve"; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly issued_at: string; readonly not_before: string;
  readonly expires_at: string; readonly nonce: string; readonly signing_key_id: string; readonly signature: string;
};
export type MemoryEffectAcceptedV2 = {
  readonly schema_version: 2; readonly kind: "accepted"; readonly state: "pending";
  readonly request_id: string; readonly request_digest: string; readonly idempotency_key: string;
  readonly envelope_digest: string; readonly lane: MemoryEffectLaneV2; readonly operation: MemoryEffectOperationV2;
  readonly accepted_at: string; readonly queue_locator: string; readonly request_file_digest: string;
  readonly replayed: boolean; readonly capability_verified: true; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly provider_instance_id: string;
};
export type MemoryEffectSpecV2 = Omit<MemoryEffectWriteRequestV2,
  "request_id" | "request_digest" | "idempotency_key" | "envelope_digest" | "delegation">;
export type MemoryEffectDelegationAuthorityV2 = {
  readonly principal_id: "principal:owner"; readonly not_before: string; readonly nonce: string;
  readonly signing_key_id: string;
};
export type MemoryEffectValidationOptions = {
  readonly now: Date; readonly expectedProvider?: string;
  readonly delegationKeys: ReadonlyMap<string, string | KeyObject>;
  readonly externalReceiptKeys?: ReadonlyMap<string, string | KeyObject>;
};

export class MemoryEffectValidationError extends Error {
  readonly name = "MemoryEffectValidationError";
  constructor(readonly code: string) { super(code); }
}

const ROOT_KEYS = ["schema_version", "kind", "provider_instance_id", "lane", "lane_id", "operation",
  "request_id", "request_digest", "idempotency_key", "envelope_digest", "target_manifest_digest", "targets",
  "scope", "scope_digest", "expected_prior", "tombstone_high_water", "tombstone_chain_delta", "delegation",
  "created_at", "expires_at", "payload"] as const;
const TARGET_KEYS = ["schema_version", "target_id", "target_digest", "provider_instance_id", "generation_id",
  "generation_manifest_digest", "vault_head", "vault_tree", "page_id", "page_blob_oid", "page_content_digest",
  "source_identity_full", "content_identity_full", "citation_identity_full", "citation_span_start", "citation_span_end",
  "subject_digest", "sensitivity", "valid_from", "valid_until", "source_owner_class", "source_owner_id_digest",
  "resolved_at", "expires_at"] as const;
const PRIOR_KEYS = ["provider_instance_id", "generation_id", "generation_manifest_digest", "vault_head", "vault_tree",
  "page_blob_oid", "page_content_digest", "citation_identity_full"] as const;
const SCOPE_KEYS = ["format", "sensitivity_classes", "valid_from", "valid_until", "max_records", "max_bytes",
  "source_owner_classes"] as const;
const CHAIN_KEYS = ["sequence", "tombstone_id", "operation", "lane_id", "target_manifest_digest", "scope_digest",
  "authority_receipt_digest", "payload_digest", "keyed_subject_digest", "effective_at", "previous_root", "set_root"] as const;
const DELEGATION_KEYS = ["schema_version", "delegation_id", "delegation_digest", "provider_instance_id", "purpose",
  "operation", "lane_id", "request_id", "request_digest", "payload_digest", "target_manifest_digest", "scope_digest",
  "expected_prior", "tombstone_sequence", "tombstone_set_root", "principal_id", "issued_at", "not_before", "expires_at",
  "nonce", "max_uses", "signing_key_id", "signature"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HMAC = /^hmac-sha256:[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const PURPOSE = { correct: "memory_correction", forget: "memory_delete", export: "memory_export" } as const;
const LANE_OPERATION = { correction: "correct", deletion: "forget", export: "export" } as const;
const LANE_PREFIX = { correction: "memcorr:req:v1:", deletion: "memdel:req:v1:", export: "memexp:req:v1:" } as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const OWNER_CLASSES = ["provider_owned", "external_read_only"] as const;

function reject(code: string): never { throw new MemoryEffectValidationError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, keys: readonly string[], code = "EFFECT_REQUEST_INVALID"): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) reject(code);
}
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 20 || utilTypes.isProxy(value)) reject("EFFECT_REQUEST_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value !== value.normalize("NFC")) reject("EFFECT_REQUEST_INVALID");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) reject("EFFECT_REQUEST_INVALID");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) reject("EFFECT_REQUEST_INVALID");
    return value.map(item => snapshot(item, depth + 1));
  }
  if (!isRecord(value)) reject("EFFECT_REQUEST_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__") reject("EFFECT_REQUEST_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) reject("EFFECT_REQUEST_INVALID");
    result[key] = snapshot(descriptor.value, depth + 1);
  }
  return result;
}
function text(record: Record<string, unknown>, key: string, code: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) reject(code);
  return value;
}
function integer(record: Record<string, unknown>, key: string, code: string): number {
  const value = record[key]; if (typeof value !== "number" || !Number.isSafeInteger(value)) reject(code); return value;
}
function instant(value: unknown, code: string): number {
  if (typeof value !== "string" || !INSTANT.test(value)) reject(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) reject(code);
  return parsed;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values, code: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value as Values[number])) reject(code);
  return value as Values[number];
}
function jsonDigest(domain: keyof typeof MEMORY_EFFECT_DOMAINS, value: unknown): string {
  return `sha256:${createHash("sha256").update(MEMORY_EFFECT_DOMAINS[domain]).update(canonicalize(value)).digest("hex")}`;
}
export function memoryEffectDigest(domain: keyof typeof MEMORY_EFFECT_DOMAINS, value: unknown): string {
  return jsonDigest(domain, value);
}
function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function keyLike(value: string | KeyObject): KeyObject | string {
  return typeof value === "string" ? createPublicKey(value) : value;
}
function signatureBytes(value: unknown, code: string): Buffer {
  if (typeof value !== "string" || !SIGNATURE.test(value)) reject(code);
  const result = Buffer.from(value, "base64url"); if (result.byteLength !== 64) reject(code); return result;
}
function verifySignature(key: string | KeyObject | undefined, domain: string, body: unknown, signature: unknown, code: string): void {
  if (key === undefined) reject(code);
  try {
    if (!verify(null, Buffer.from(domain + canonicalize(body)), keyLike(key), signatureBytes(signature, code))) reject(code);
  } catch (error) { if (error instanceof MemoryEffectValidationError) throw error; reject(code); }
}

function validateTarget(value: unknown, provider: string, nowMs: number): ResolvedMemoryTargetV2 {
  if (!isRecord(value)) reject("EFFECT_TARGET_INVALID"); exact(value, TARGET_KEYS, "EFFECT_TARGET_INVALID");
  if (value.schema_version !== 1 || value.provider_instance_id !== provider) reject("EFFECT_TARGET_INVALID");
  const core = without(value, ["target_id", "target_digest"]); const observed = jsonDigest("target", core);
  if (value.target_digest !== observed || value.target_id !== `sbtarget:v1:${observed.slice(7)}`) reject("EFFECT_TARGET_INVALID");
  for (const key of ["source_identity_full", "content_identity_full", "citation_identity_full"])
    if (!HEX64.test(text(value, key, "EFFECT_TARGET_INVALID"))) reject("EFFECT_TARGET_INVALID");
  for (const key of ["generation_manifest_digest", "page_content_digest", "subject_digest", "source_owner_id_digest"])
    if (!DIGEST.test(text(value, key, "EFFECT_TARGET_INVALID"))) reject("EFFECT_TARGET_INVALID");
  for (const key of ["vault_head", "vault_tree", "page_blob_oid"])
    if (!HEX40.test(text(value, key, "EFFECT_TARGET_INVALID"))) reject("EFFECT_TARGET_INVALID");
  member(value.sensitivity, SENSITIVITIES, "EFFECT_TARGET_INVALID");
  member(value.source_owner_class, OWNER_CLASSES, "EFFECT_TARGET_INVALID");
  const start = integer(value, "citation_span_start", "EFFECT_TARGET_INVALID");
  const end = integer(value, "citation_span_end", "EFFECT_TARGET_INVALID");
  const validFrom = instant(value.valid_from, "EFFECT_TARGET_INVALID");
  const validUntil = instant(value.valid_until, "EFFECT_TARGET_INVALID");
  const resolved = instant(value.resolved_at, "EFFECT_TARGET_INVALID");
  const expires = instant(value.expires_at, "EFFECT_TARGET_INVALID");
  if (start < 0 || start >= end || validFrom >= validUntil || resolved >= expires || expires <= nowMs
    || Buffer.byteLength(canonicalize(value), "utf8") > 16_384) reject("EFFECT_TARGET_INVALID");
  return value as ResolvedMemoryTargetV2;
}
export function parseResolvedMemoryTarget(value: unknown, provider: string, now: Date): ResolvedMemoryTargetV2 | undefined {
  try {
    const raw = snapshot(value); const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return undefined;
    return Object.freeze(validateTarget(raw, provider, nowMs));
  } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; }
}
function validatePrior(value: unknown, targets: readonly ResolvedMemoryTargetV2[]): MemoryEffectExpectedPriorV2 {
  if (!isRecord(value)) reject("EFFECT_PRIOR_STALE"); exact(value, PRIOR_KEYS, "EFFECT_PRIOR_STALE");
  const first = targets[0]; if (first === undefined) reject("EFFECT_TARGET_INVALID");
  for (const key of ["provider_instance_id", "generation_id", "generation_manifest_digest", "vault_head", "vault_tree"] as const) {
    if (targets.some(target => target[key] !== value[key])) reject("EFFECT_PRIOR_STALE");
  }
  if (value.page_blob_oid !== first.page_blob_oid || value.page_content_digest !== first.page_content_digest
    || value.citation_identity_full !== first.citation_identity_full) reject("EFFECT_PRIOR_STALE");
  return value as MemoryEffectExpectedPriorV2;
}
function stringArray(value: unknown, allowed: readonly string[], code: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !allowed.includes(item))) reject(code);
  if (value.join("\0") !== [...new Set(value)].sort().join("\0")) reject(code);
  return value as string[];
}
function validateScope(value: unknown, targets: readonly ResolvedMemoryTargetV2[], operation: MemoryEffectOperationV2): MemoryEffectScopeV2 {
  if (!isRecord(value)) reject("EFFECT_SCOPE_INVALID"); exact(value, SCOPE_KEYS, "EFFECT_SCOPE_INVALID");
  const format = member(value.format, ["none", "json"] as const, "EFFECT_SCOPE_INVALID");
  const sensitivities = stringArray(value.sensitivity_classes, SENSITIVITIES, "EFFECT_SCOPE_INVALID");
  const owners = stringArray(value.source_owner_classes, OWNER_CLASSES, "EFFECT_SCOPE_INVALID");
  const maxRecords = integer(value, "max_records", "EFFECT_SCOPE_INVALID");
  const maxBytes = integer(value, "max_bytes", "EFFECT_SCOPE_INVALID");
  const from = instant(value.valid_from, "EFFECT_SCOPE_INVALID"); const until = instant(value.valid_until, "EFFECT_SCOPE_INVALID");
  if (sensitivities.length === 0 || owners.length === 0 || maxRecords < targets.length || maxRecords < 1 || maxRecords > 64
    || maxBytes < 1 || maxBytes > 1_048_576 || from >= until || format !== (operation === "export" ? "json" : "none")) reject("EFFECT_SCOPE_INVALID");
  if (targets.some(target => !sensitivities.includes(target.sensitivity) || !owners.includes(target.source_owner_class)
    || Date.parse(target.valid_from) < from || Date.parse(target.valid_until) > until)) reject("EFFECT_SCOPE_INVALID");
  return value as MemoryEffectScopeV2;
}
function validateExternalReceipt(value: unknown, requestScope: string, externalOwners: ReadonlySet<string>,
  keys: ReadonlyMap<string, string | KeyObject> | undefined): ExternalErasureReceiptV2 {
  const fields = ["owner_id_digest", "receipt_id", "receipt_digest", "scope_digest", "deleted_at", "signing_key_id", "signature"];
  if (!isRecord(value)) reject("EXTERNAL_RECEIPT_INVALID"); exact(value, fields, "EXTERNAL_RECEIPT_INVALID");
  const body = without(value, ["receipt_id", "receipt_digest", "signature"]); const observed = jsonDigest("external_receipt", body);
  const owner = text(value, "owner_id_digest", "EXTERNAL_RECEIPT_INVALID");
  const signingKey = text(value, "signing_key_id", "EXTERNAL_RECEIPT_INVALID");
  if (value.receipt_digest !== observed || value.receipt_id !== `exterase:v1:${observed.slice(7)}`
    || value.scope_digest !== requestScope || !externalOwners.has(owner) || Buffer.byteLength(canonicalize(value)) > 2_048) reject("EXTERNAL_RECEIPT_INVALID");
  instant(value.deleted_at, "EXTERNAL_RECEIPT_INVALID");
  verifySignature(keys?.get(signingKey), EXTERNAL_ERASURE_SIGNATURE_DOMAIN, without(value, ["signature"]), value.signature, "EXTERNAL_RECEIPT_INVALID");
  return value as ExternalErasureReceiptV2;
}
function validatePayload(value: unknown, operation: MemoryEffectOperationV2, scope: MemoryEffectScopeV2,
  targets: readonly ResolvedMemoryTargetV2[], scopeDigest: string,
  externalKeys: ReadonlyMap<string, string | KeyObject> | undefined): MemoryEffectPayloadV2 {
  if (!isRecord(value)) reject("EFFECT_PAYLOAD_INVALID");
  if (operation === "correct") {
    exact(value, ["content", "content_digest", "content_bytes", "disposition"], "EFFECT_PAYLOAD_INVALID");
    const content = text(value, "content", "EFFECT_PAYLOAD_INVALID"); const bytes = Buffer.byteLength(content, "utf8");
    if (content !== content.trim() || bytes < 1 || bytes > 4_096 || value.content_bytes !== bytes
      || value.content_digest !== jsonDigest("effect_content", { content }) || value.disposition !== "superseded") reject("EFFECT_PAYLOAD_INVALID");
    return value as MemoryCorrectionPayloadV2;
  }
  if (operation === "forget") {
    exact(value, ["disposition", "erasure_claim", "external_receipts"], "EFFECT_PAYLOAD_INVALID");
    if (value.disposition !== "owner_requested" || !["managed_erasure", "provider_local_suppression"].includes(String(value.erasure_claim))
      || !Array.isArray(value.external_receipts) || value.external_receipts.length > 16) reject("EFFECT_PAYLOAD_INVALID");
    const externalOwners = new Set(targets.filter(target => target.source_owner_class === "external_read_only").map(target => target.source_owner_id_digest));
    if (value.erasure_claim === "managed_erasure" && externalOwners.size > 0) reject("MANAGED_ERASURE_SCOPE_INVALID");
    const receiptOwners = new Set(value.external_receipts.map(receipt => validateExternalReceipt(receipt, scopeDigest, externalOwners, externalKeys).owner_id_digest));
    if (externalOwners.size > 0 && (receiptOwners.size !== externalOwners.size
      || [...externalOwners].some(owner => !receiptOwners.has(owner)))) reject("EXTERNAL_RECEIPT_INVALID");
    return value as MemoryDeletePayloadV2;
  }
  exact(value, ["format", "target_record_ids", "sensitivity_classes", "valid_from", "valid_until", "max_records", "max_bytes"], "EFFECT_PAYLOAD_INVALID");
  if (value.format !== "json" || !Array.isArray(value.target_record_ids)
    || value.target_record_ids.join("\0") !== targets.map(target => target.target_id).join("\0")
    || !Array.isArray(value.sensitivity_classes) || value.sensitivity_classes.join("\0") !== scope.sensitivity_classes.join("\0")
    || value.valid_from !== scope.valid_from || value.valid_until !== scope.valid_until
    || value.max_records !== scope.max_records || value.max_bytes !== scope.max_bytes) reject("EXPORT_SCOPE_AMBIGUOUS");
  return value as MemoryExportPayloadV2;
}
function validateChain(value: unknown, highValue: unknown, operation: MemoryEffectOperationV2, laneId: string,
  targetManifest: string, scopeDigest: string, payloadDigest: string): { high: MemoryTombstoneHighWaterV2; delta: readonly MemoryTombstoneChainEntryV2[] } {
  if (!isRecord(highValue)) reject("EFFECT_TOMBSTONE_DELTA_INVALID"); exact(highValue, ["sequence", "set_root"], "EFFECT_TOMBSTONE_DELTA_INVALID");
  const highSequence = integer(highValue, "sequence", "EFFECT_TOMBSTONE_DELTA_INVALID");
  if (highSequence < 0 || !DIGEST.test(text(highValue, "set_root", "EFFECT_TOMBSTONE_DELTA_INVALID")) || !Array.isArray(value)
    || value.length > 256 || (operation !== "export" && value.length === 0)) reject("EFFECT_TOMBSTONE_DELTA_INVALID");
  let priorSequence: number | undefined; let priorRoot: string | undefined; const seen = new Set<string>();
  const delta = value.map(raw => {
    if (!isRecord(raw)) reject("EFFECT_TOMBSTONE_DELTA_INVALID"); exact(raw, CHAIN_KEYS, "EFFECT_TOMBSTONE_DELTA_INVALID");
    const sequence = integer(raw, "sequence", "EFFECT_TOMBSTONE_DELTA_INVALID"); const root = text(raw, "set_root", "EFFECT_TOMBSTONE_DELTA_INVALID");
    const id = text(raw, "tombstone_id", "EFFECT_TOMBSTONE_DELTA_INVALID"); const core = without(raw, ["tombstone_id", "set_root"]);
    const observed = jsonDigest("tombstone_chain", core);
    if ((priorSequence !== undefined && sequence !== priorSequence + 1) || (priorRoot !== undefined && raw.previous_root !== priorRoot)
      || seen.has(id) || root !== observed || id !== `memtomb:v1:${observed.slice(7)}` || raw.operation !== operation
      || raw.lane_id !== laneId || raw.target_manifest_digest !== targetManifest || raw.scope_digest !== scopeDigest
      || raw.payload_digest !== payloadDigest || !HMAC.test(text(raw, "keyed_subject_digest", "EFFECT_TOMBSTONE_DELTA_INVALID"))
      || !DIGEST.test(text(raw, "authority_receipt_digest", "EFFECT_TOMBSTONE_DELTA_INVALID"))) reject("EFFECT_TOMBSTONE_DELTA_INVALID");
    instant(raw.effective_at, "EFFECT_TOMBSTONE_DELTA_INVALID");
    priorSequence = sequence; priorRoot = root; seen.add(id); return raw as MemoryTombstoneChainEntryV2;
  });
  const last = delta.at(-1);
  if (last !== undefined && (last.sequence !== highSequence || last.set_root !== highValue.set_root)) reject("EFFECT_TOMBSTONE_DELTA_INVALID");
  return { high: highValue as MemoryTombstoneHighWaterV2, delta };
}

export function requireMemoryEffectWriteRequest(value: unknown, options: MemoryEffectValidationOptions): MemoryEffectWriteRequestV2 {
  const raw = snapshot(value); if (!isRecord(raw)) reject("EFFECT_REQUEST_INVALID");
  const bytes = Buffer.byteLength(canonicalize(raw), "utf8"); if (bytes > 262_144) reject("EFFECT_REQUEST_OVERSIZE");
  exact(raw, ROOT_KEYS); if (raw.schema_version !== 2 || raw.kind !== "memory_effect") reject("EFFECT_REQUEST_INVALID");
  const provider = text(raw, "provider_instance_id", "EFFECT_IDENTITY_INVALID");
  if (options.expectedProvider !== undefined && provider !== options.expectedProvider) reject("EFFECT_IDENTITY_INVALID");
  const lane = member(raw.lane, ["correction", "deletion", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const operation = member(raw.operation, ["correct", "forget", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const laneId = text(raw, "lane_id", "EFFECT_IDENTITY_INVALID");
  if (LANE_OPERATION[lane] !== operation || !new RegExp(`^${LANE_PREFIX[lane]}[0-9a-f]{64}$`).test(laneId)) reject("EFFECT_OPERATION_CONFUSION");
  const nowMs = options.now.getTime(); if (!Number.isFinite(nowMs)) reject("EFFECT_REQUEST_INVALID");
  const created = instant(raw.created_at, "EFFECT_REQUEST_INVALID"); const expires = instant(raw.expires_at, "EFFECT_REQUEST_INVALID");
  if (created > nowMs || nowMs >= expires || expires <= created || expires - created > 15 * 60_000) reject("EFFECT_REQUEST_INVALID");
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 64) reject("EFFECT_TARGET_INVALID");
  const targets = raw.targets.map(target => validateTarget(target, provider, nowMs));
  const targetDigests = targets.map(target => target.target_digest);
  if (targetDigests.join("\0") !== [...new Set(targetDigests)].sort().join("\0")) reject("EFFECT_TARGET_AMBIGUOUS");
  const targetManifest = jsonDigest("target_manifest", { targets });
  if (raw.target_manifest_digest !== targetManifest) reject("EFFECT_TARGET_INVALID");
  const scope = validateScope(raw.scope, targets, operation);
  const scopeDigest = jsonDigest("target_scope", { target_digests: targetDigests, scope });
  if (raw.scope_digest !== scopeDigest) reject("EFFECT_SCOPE_INVALID");
  const prior = validatePrior(raw.expected_prior, targets);
  const payload = validatePayload(raw.payload, operation, scope, targets, scopeDigest, options.externalReceiptKeys);
  const payloadDigest = jsonDigest("effect_payload", payload);
  const chain = validateChain(raw.tombstone_chain_delta, raw.tombstone_high_water, operation, laneId, targetManifest, scopeDigest, payloadDigest);
  const spec = without(raw, ["request_id", "request_digest", "idempotency_key", "delegation", "envelope_digest"]);
  if (Buffer.byteLength(canonicalize(spec), "utf8") > 196_608) reject("EFFECT_REQUEST_OVERSIZE");
  const requestDigest = jsonDigest("effect_spec", spec); const requestId = `memeff:req:v2:${requestDigest.slice(7)}`;
  if (raw.request_digest !== requestDigest) reject("EFFECT_SPEC_DIGEST_INVALID");
  if (raw.request_id !== requestId) reject("EFFECT_IDENTITY_INVALID");
  const idem = jsonDigest("effect_idempotency", { lane, lane_id: laneId, operation, request_id: requestId,
    request_digest: requestDigest, target_manifest_digest: targetManifest, scope_digest: scopeDigest });
  if (raw.idempotency_key !== `memeff:idem:v2:${idem.slice(7)}`) reject("EFFECT_IDEMPOTENCY_INVALID");
  if (!isRecord(raw.delegation)) reject("EFFECT_DELEGATION_INVALID"); const delegation = raw.delegation;
  exact(delegation, DELEGATION_KEYS, "EFFECT_DELEGATION_INVALID");
  const delegationBody = without(delegation, ["delegation_id", "delegation_digest", "signature"]);
  const delegationDigest = jsonDigest("delegation", delegationBody);
  const signingKey = text(delegation, "signing_key_id", "EFFECT_DELEGATION_INVALID");
  const delegationIssued = instant(delegation.issued_at, "EFFECT_DELEGATION_INVALID");
  const delegationNotBefore = instant(delegation.not_before, "EFFECT_DELEGATION_INVALID");
  const delegationExpires = instant(delegation.expires_at, "EFFECT_DELEGATION_INVALID");
  if (delegation.schema_version !== 1 || delegation.delegation_digest !== delegationDigest
    || delegation.delegation_id !== `memdeleg:v1:${delegationDigest.slice(7)}` || delegation.provider_instance_id !== provider
    || delegation.purpose !== PURPOSE[operation] || delegation.operation !== operation || delegation.lane_id !== laneId
    || delegation.request_id !== requestId || delegation.request_digest !== requestDigest || delegation.payload_digest !== payloadDigest
    || delegation.target_manifest_digest !== targetManifest || delegation.scope_digest !== scopeDigest
    || canonicalize(delegation.expected_prior) !== canonicalize(prior) || delegation.tombstone_sequence !== chain.high.sequence
    || delegation.tombstone_set_root !== chain.high.set_root || delegation.principal_id !== "principal:owner"
    || delegation.issued_at !== raw.created_at || delegation.expires_at !== raw.expires_at || delegation.max_uses !== 1
    || delegationIssued > delegationNotBefore || delegationNotBefore > nowMs || nowMs >= delegationExpires) reject("EFFECT_DELEGATION_INVALID");
  verifySignature(options.delegationKeys.get(signingKey), MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN,
    without(delegation, ["signature"]), delegation.signature, "EFFECT_DELEGATION_INVALID");
  const envelope = without(raw, ["envelope_digest"]);
  if (raw.envelope_digest !== jsonDigest("envelope", envelope)) reject("EFFECT_ENVELOPE_DIGEST_INVALID");
  return Object.freeze({ ...raw, targets: Object.freeze(targets), scope: Object.freeze(scope), expected_prior: Object.freeze(prior),
    tombstone_high_water: Object.freeze(chain.high), tombstone_chain_delta: Object.freeze(chain.delta),
    delegation: Object.freeze(delegation), payload: Object.freeze(payload) }) as unknown as MemoryEffectWriteRequestV2;
}
export function parseMemoryEffectWriteRequest(value: unknown, options: MemoryEffectValidationOptions): MemoryEffectWriteRequestV2 | undefined {
  try { return requireMemoryEffectWriteRequest(value, options); } catch (error) {
    if (error instanceof MemoryEffectValidationError) return undefined; throw error;
  }
}
export function snapshotMemoryEffectWriteArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    const raw = snapshot(value); if (!isRecord(raw)) return undefined;
    exact(raw, ["request"]); const request = raw.request;
    if (!isRecord(request)) return undefined; exact(request, ROOT_KEYS);
    if (request.schema_version !== 2 || request.kind !== "memory_effect"
      || Buffer.byteLength(canonicalize(request), "utf8") > 262_144) return undefined;
    return Object.freeze(raw);
  } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; }
}

export function createMemoryReadFence(input: Omit<MemoryReadFenceV1,
  "schema_version" | "fence_id" | "fence_digest" | "principal_id" | "signature">,
  privateKey: KeyObject): MemoryReadFenceV1 {
  const expectedOperation = { memory_read: "read", memory_status: "status", memory_resolve: "resolve" } as const;
  if (input.operation !== expectedOperation[input.purpose] || input.tombstone_sequence < 0
    || !Number.isSafeInteger(input.tombstone_sequence) || !DIGEST.test(input.tombstone_set_root)) reject("TOMBSTONE_FENCE_INVALID");
  const body = { schema_version: 1 as const, provider_instance_id: input.provider_instance_id, principal_id: "principal:owner" as const,
    purpose: input.purpose, operation: input.operation, tombstone_sequence: input.tombstone_sequence,
    tombstone_set_root: input.tombstone_set_root, issued_at: input.issued_at, not_before: input.not_before,
    expires_at: input.expires_at, nonce: input.nonce, signing_key_id: input.signing_key_id };
  const observed = jsonDigest("read_fence", body);
  const unsigned = { ...body, fence_id: `memfence:v1:${observed.slice(7)}`, fence_digest: observed };
  return { ...unsigned,
    signature: sign(null, Buffer.from(MEMORY_READ_FENCE_SIGNATURE_DOMAIN + canonicalize(unsigned)), privateKey).toString("base64url") };
}

export function createMemoryEffectWriteRequest(specification: MemoryEffectSpecV2,
  authority: MemoryEffectDelegationAuthorityV2, privateKey: KeyObject): MemoryEffectWriteRequestV2 {
  const spec = snapshot(specification); if (!isRecord(spec)) reject("EFFECT_REQUEST_INVALID");
  const requestDigest = jsonDigest("effect_spec", spec); const requestId = `memeff:req:v2:${requestDigest.slice(7)}`;
  const lane = member(spec.lane, ["correction", "deletion", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const operation = member(spec.operation, ["correct", "forget", "export"] as const, "EFFECT_OPERATION_CONFUSION");
  const targetManifest = text(spec, "target_manifest_digest", "EFFECT_TARGET_INVALID");
  const scopeDigest = text(spec, "scope_digest", "EFFECT_SCOPE_INVALID");
  const laneId = text(spec, "lane_id", "EFFECT_IDENTITY_INVALID");
  const idemDigest = jsonDigest("effect_idempotency", { lane, lane_id: laneId, operation, request_id: requestId,
    request_digest: requestDigest, target_manifest_digest: targetManifest, scope_digest: scopeDigest });
  const payloadDigest = jsonDigest("effect_payload", spec.payload);
  if (!isRecord(spec.tombstone_high_water) || !isRecord(spec.expected_prior)) reject("EFFECT_REQUEST_INVALID");
  const delegationBody = {
    schema_version: 1, provider_instance_id: spec.provider_instance_id, purpose: PURPOSE[operation], operation,
    lane_id: laneId, request_id: requestId, request_digest: requestDigest, payload_digest: payloadDigest,
    target_manifest_digest: targetManifest, scope_digest: scopeDigest, expected_prior: spec.expected_prior,
    tombstone_sequence: spec.tombstone_high_water.sequence, tombstone_set_root: spec.tombstone_high_water.set_root,
    principal_id: authority.principal_id, issued_at: spec.created_at, not_before: authority.not_before,
    expires_at: spec.expires_at, nonce: authority.nonce, max_uses: 1, signing_key_id: authority.signing_key_id,
  };
  const delegationDigest = jsonDigest("delegation", delegationBody);
  const unsignedDelegation = { ...delegationBody, delegation_id: `memdeleg:v1:${delegationDigest.slice(7)}`,
    delegation_digest: delegationDigest };
  const delegation = { ...unsignedDelegation,
    signature: sign(null, Buffer.from(MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN + canonicalize(unsignedDelegation)), privateKey).toString("base64url") };
  const envelope = { ...spec, request_id: requestId, request_digest: requestDigest,
    idempotency_key: `memeff:idem:v2:${idemDigest.slice(7)}`, delegation };
  const request = { ...envelope, envelope_digest: jsonDigest("envelope", envelope) };
  return request as unknown as MemoryEffectWriteRequestV2;
}

const ACCEPTED_KEYS = ["schema_version", "kind", "state", "request_id", "request_digest", "idempotency_key",
  "envelope_digest", "lane", "operation", "accepted_at", "queue_locator", "request_file_digest", "replayed",
  "capability_verified", "tombstone_sequence", "tombstone_set_root", "provider_instance_id"] as const;
export function parseMemoryEffectAccepted(value: unknown): MemoryEffectAcceptedV2 | undefined {
  try {
    const raw = snapshot(value); if (!isRecord(raw)) return undefined; exact(raw, ACCEPTED_KEYS, "EFFECT_RESULT_INVALID");
    if (raw.schema_version !== 2 || raw.kind !== "accepted" || raw.state !== "pending" || raw.capability_verified !== true
      || typeof raw.replayed !== "boolean" || !/^memeff:req:v2:[0-9a-f]{64}$/.test(text(raw, "request_id", "EFFECT_RESULT_INVALID"))
      || !/^memeff:idem:v2:[0-9a-f]{64}$/.test(text(raw, "idempotency_key", "EFFECT_RESULT_INVALID"))) return undefined;
    for (const key of ["request_digest", "envelope_digest", "request_file_digest", "tombstone_set_root"])
      if (!DIGEST.test(text(raw, key, "EFFECT_RESULT_INVALID"))) return undefined;
    member(raw.lane, ["correction", "deletion", "export"] as const, "EFFECT_RESULT_INVALID");
    member(raw.operation, ["correct", "forget", "export"] as const, "EFFECT_RESULT_INVALID");
    instant(raw.accepted_at, "EFFECT_RESULT_INVALID");
    if (integer(raw, "tombstone_sequence", "EFFECT_RESULT_INVALID") < 0 || !text(raw, "queue_locator", "EFFECT_RESULT_INVALID")
      || !text(raw, "provider_instance_id", "EFFECT_RESULT_INVALID")) return undefined;
    return Object.freeze(raw) as unknown as MemoryEffectAcceptedV2;
  } catch (error) { if (error instanceof MemoryEffectValidationError) return undefined; throw error; }
}
