import type { KeyObject } from "node:crypto"; export const MEMORY_EFFECT_DOMAINS = Object.freeze({ target: "second-brain/memory-target/v1\0",
  target_manifest: "second-brain/memory-target-manifest/v1\0", target_scope: "second-brain/memory-target-scope/v1\0",
  effect_content: "orca-jarvis/memory-effect-content/v2\0", effect_payload: "orca-jarvis/memory-effect-payload/v2\0",
  tombstone_chain: "orca-jarvis/memory-tombstone-chain/v1\0", effect_spec: "orca-jarvis/memory-effect-spec/v2\0",
  effect_idempotency: "orca-jarvis/memory-effect-idempotency/v2\0", delegation: "orca-jarvis/memory-effect-delegation/v1\0",
  delegation_revocation: "orca-jarvis/memory-effect-delegation-revocation/v1\0", envelope: "orca-jarvis/memory-effect-envelope/v2\0",
  request_file: "second-brain/memory-effect-request-file/v2\0", read_fence: "orca-jarvis/memory-read-fence/v1\0",
  external_receipt: "external-owner/memory-erasure-receipt/v1\0", }); export const MEMORY_EFFECT_DELEGATION_SIGNATURE_DOMAIN =
  "orca-jarvis/memory-effect-delegation/v1\0"; export const EXTERNAL_ERASURE_SIGNATURE_DOMAIN = "external-owner/memory-erasure-receipt/v1\0";
export const MEMORY_READ_FENCE_SIGNATURE_DOMAIN = "orca-jarvis/memory-read-fence/v1\0"; export const MEMORY_TOMBSTONE_GENESIS_ROOT =
  "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3"; export type MemoryEffectOperationV2 = "correct" | "forget" | "export";
export type MemoryEffectLaneV2 = "correction" | "deletion" | "export"; export type MemorySensitivity = "public" | "personal" | "sensitive" | "restricted";
export type MemorySourceOwnerClass = "provider_owned" | "external_read_only"; export type ResolvedMemoryTargetV2 = { readonly schema_version: 1;
  readonly target_id: string; readonly target_digest: string; readonly provider_instance_id: string; readonly generation_id: string;
  readonly generation_manifest_digest: string; readonly vault_head: string; readonly vault_tree: string; readonly page_id: string;
  readonly page_blob_oid: string; readonly page_content_digest: string; readonly source_identity_full: string; readonly content_identity_full: string;
  readonly citation_identity_full: string; readonly citation_span_start: number; readonly citation_span_end: number; readonly subject_digest: string;
  readonly sensitivity: MemorySensitivity; readonly valid_from: string; readonly valid_until: string; readonly source_owner_class: MemorySourceOwnerClass;
  readonly source_owner_id_digest: string; readonly resolved_at: string; readonly expires_at: string; }; export type MemoryEffectExpectedPriorV2 = {
  readonly provider_instance_id: string; readonly generation_id: string; readonly generation_manifest_digest: string; readonly vault_head: string;
  readonly vault_tree: string; readonly page_blob_oid: string; readonly page_content_digest: string; readonly citation_identity_full: string; };
export type MemoryEffectScopeV2 = { readonly format: "none" | "json"; readonly sensitivity_classes: readonly MemorySensitivity[]; readonly valid_from: string;
  readonly valid_until: string; readonly max_records: number; readonly max_bytes: number; readonly source_owner_classes: readonly MemorySourceOwnerClass[]; };
export type MemoryTombstoneHighWaterV2 = { readonly sequence: number; readonly set_root: string; }; export type MemoryTombstoneChainEntryV2 = {
  readonly sequence: number; readonly tombstone_id: string; readonly operation: "correct" | "forget"; readonly lane_id: string;
  readonly target_manifest_digest: string; readonly scope_digest: string; readonly authority_receipt_digest: string; readonly payload_digest: string;
  readonly keyed_subject_digest: string; readonly effective_at: string; readonly previous_root: string; readonly set_root: string; };
export type ExternalErasureReceiptV2 = { readonly owner_id_digest: string; readonly receipt_id: string; readonly receipt_digest: string;
  readonly scope_digest: string; readonly deleted_at: string; readonly signing_key_id: string; readonly signature: string; };
export type MemoryCorrectionPayloadV2 = { readonly content: string; readonly content_digest: string; readonly content_bytes: number;
  readonly disposition: "superseded"; }; export type MemoryDeletePayloadV2 = { readonly disposition: "owner_requested";
  readonly erasure_claim: "managed_erasure" | "provider_local_suppression"; readonly external_receipts: readonly ExternalErasureReceiptV2[]; };
export type MemoryExportPayloadV2 = { readonly format: "json"; readonly target_record_ids: readonly string[];
  readonly sensitivity_classes: readonly MemorySensitivity[]; readonly valid_from: string; readonly valid_until: string; readonly max_records: number;
  readonly max_bytes: number; }; export type MemoryEffectPayloadV2 = | MemoryCorrectionPayloadV2 | MemoryDeletePayloadV2 | MemoryExportPayloadV2;
export type MemoryEffectDelegationV2 = { readonly schema_version: 1; readonly delegation_id: string; readonly delegation_digest: string;
  readonly provider_instance_id: string; readonly purpose: "memory_correction" | "memory_delete" | "memory_export"; readonly operation: MemoryEffectOperationV2;
  readonly lane_id: string; readonly request_id: string; readonly request_digest: string; readonly payload_digest: string;
  readonly target_manifest_digest: string; readonly scope_digest: string; readonly expected_prior: MemoryEffectExpectedPriorV2;
  readonly tombstone_sequence: number; readonly tombstone_set_root: string; readonly principal_id: "principal:owner"; readonly issued_at: string;
  readonly not_before: string; readonly expires_at: string; readonly nonce: string; readonly max_uses: 1; readonly signing_key_id: string;
  readonly signature: string; }; export type MemoryEffectWriteRequestV2 = { readonly schema_version: 2; readonly kind: "memory_effect";
  readonly provider_instance_id: string; readonly lane: MemoryEffectLaneV2; readonly lane_id: string; readonly operation: MemoryEffectOperationV2;
  readonly request_id: string; readonly request_digest: string; readonly idempotency_key: string; readonly envelope_digest: string;
  readonly target_manifest_digest: string; readonly targets: readonly ResolvedMemoryTargetV2[]; readonly scope: MemoryEffectScopeV2;
  readonly scope_digest: string; readonly expected_prior: MemoryEffectExpectedPriorV2; readonly tombstone_high_water: MemoryTombstoneHighWaterV2;
  readonly tombstone_chain_delta: readonly MemoryTombstoneChainEntryV2[]; readonly delegation: MemoryEffectDelegationV2; readonly created_at: string;
  readonly expires_at: string; readonly payload: MemoryEffectPayloadV2; }; export type MemoryReadFenceV1 = { readonly schema_version: 1;
  readonly fence_id: string; readonly fence_digest: string; readonly provider_instance_id: string; readonly principal_id: "principal:owner";
  readonly purpose: "memory_read" | "memory_status" | "memory_resolve"; readonly operation: "read" | "status" | "resolve"; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly issued_at: string; readonly not_before: string; readonly expires_at: string; readonly nonce: string;
  readonly signing_key_id: string; readonly signature: string; }; export type MemoryEffectAcceptedV2 = { readonly schema_version: 2; readonly kind: "accepted";
  readonly state: "pending"; readonly request_id: string; readonly request_digest: string; readonly idempotency_key: string; readonly envelope_digest: string;
  readonly lane: MemoryEffectLaneV2; readonly operation: MemoryEffectOperationV2; readonly accepted_at: string; readonly queue_locator: string;
  readonly request_file_digest: string; readonly replayed: boolean; readonly capability_verified: true; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly provider_instance_id: string; }; export type MemoryEffectSpecV2 = Omit< MemoryEffectWriteRequestV2,
  "request_id" | "request_digest" | "idempotency_key" | "envelope_digest" | "delegation" >; export type MemoryEffectDelegationAuthorityV2 = {
  readonly principal_id: "principal:owner"; readonly not_before: string; readonly nonce: string; readonly signing_key_id: string; };
export type MemoryEffectValidationOptions = { readonly now: Date; readonly expectedProvider?: string;
  readonly delegationKeys: ReadonlyMap<string, string | KeyObject>; readonly externalReceiptKeys?: ReadonlyMap<string, string | KeyObject>; };
export class MemoryEffectValidationError extends Error { readonly name = "MemoryEffectValidationError"; constructor(readonly code: string) { super(code); } }
export const MEMORY_EFFECT_ROOT_KEYS = [ "schema_version", "kind", "provider_instance_id", "lane", "lane_id", "operation",
  "request_id", "request_digest", "idempotency_key", "envelope_digest", "target_manifest_digest", "targets", "scope", "scope_digest", "expected_prior",
  "tombstone_high_water", "tombstone_chain_delta", "delegation", "created_at", "expires_at", "payload", ] as const; export const MEMORY_EFFECT_TARGET_KEYS = [
  "schema_version", "target_id", "target_digest", "provider_instance_id", "generation_id",
  "generation_manifest_digest", "vault_head", "vault_tree", "page_id", "page_blob_oid", "page_content_digest", "source_identity_full", "content_identity_full",
  "citation_identity_full", "citation_span_start", "citation_span_end", "subject_digest", "sensitivity", "valid_from", "valid_until", "source_owner_class",
  "source_owner_id_digest", "resolved_at", "expires_at", ] as const; export const MEMORY_EFFECT_PRIOR_KEYS = [
  "provider_instance_id", "generation_id", "generation_manifest_digest", "vault_head",
  "vault_tree", "page_blob_oid", "page_content_digest", "citation_identity_full", ] as const; export const MEMORY_EFFECT_SCOPE_KEYS = [
  "format", "sensitivity_classes", "valid_from", "valid_until", "max_records", "max_bytes", "source_owner_classes", ] as const;
export const MEMORY_EFFECT_CHAIN_KEYS = [ "sequence", "tombstone_id", "operation", "lane_id", "target_manifest_digest",
  "scope_digest", "authority_receipt_digest", "payload_digest", "keyed_subject_digest", "effective_at", "previous_root", "set_root", ] as const;
export const MEMORY_EFFECT_DELEGATION_KEYS = [ "schema_version", "delegation_id", "delegation_digest", "provider_instance_id",
  "purpose", "operation", "lane_id", "request_id", "request_digest", "payload_digest",
  "target_manifest_digest", "scope_digest", "expected_prior", "tombstone_sequence",
  "tombstone_set_root", "principal_id", "issued_at", "not_before", "expires_at", "nonce", "max_uses", "signing_key_id", "signature", ] as const;
export const MEMORY_EFFECT_DIGEST = /^sha256:[0-9a-f]{64}$/; export const MEMORY_EFFECT_HMAC = /^hmac-sha256:[0-9a-f]{64}$/;
export const MEMORY_EFFECT_HEX40 = /^[0-9a-f]{40}$/; export const MEMORY_EFFECT_HEX64 = /^[0-9a-f]{64}$/;
export const MEMORY_EFFECT_SIGNATURE = /^[A-Za-z0-9_-]{86}$/; export const MEMORY_EFFECT_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const MEMORY_EFFECT_PURPOSE = { correct: "memory_correction", forget: "memory_delete", export: "memory_export", } as const;
export const MEMORY_EFFECT_LANE_OPERATION = { correction: "correct", deletion: "forget", export: "export", } as const;
export const MEMORY_EFFECT_LANE_PREFIX = { correction: "memcorr:req:v1:", deletion: "memdel:req:v1:", export: "memexp:req:v1:", } as const;
export const MEMORY_EFFECT_SENSITIVITIES = [ "public", "personal", "sensitive", "restricted", ] as const; export const MEMORY_EFFECT_OWNER_CLASSES = [
  "provider_owned", "external_read_only", ] as const;
