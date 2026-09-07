import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const fullIdentity = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: false, precision: 3 });
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sensitivity = z.enum(["public", "personal", "sensitive", "restricted"]);
const ownerClass = z.enum(["provider_owned", "external_read_only"]);

const v1Receipt = z.object({
  schema_version: z.literal(1),
  receipt_id: z.string().min(1).max(160),
  candidate_id: z.string().min(1).max(160),
  candidate_digest: digest,
  classification_digest: digest,
  operation: z.enum(["remember", "correct", "forget", "export"]),
  decision: z.enum(["auto_staged", "owner_confirmed"]),
  principal_id: z.literal("principal:owner"),
  issued_at: instant,
  expires_at: instant,
}).strict();
const v1Prior = z.object({
  source_id: z.string().min(1).max(512),
  source_version: z.string().min(1).max(160),
  source_digest: digest,
}).strict();
const v1Payload = z.union([
  z.object({ content: z.string().min(1).max(4_096) }).strict(),
  z.object({ disposition: z.literal("owner_requested") }).strict(),
  z.object({ format: z.literal("json"), scope: z.literal("subject") }).strict(),
]);
export const MemoryWriteRequestV1Schema = z.object({
  schema_version: z.literal(1),
  candidate_id: z.string().min(1).max(160),
  candidate_digest: digest,
  classification_digest: digest,
  idempotency_key: z.string().min(1).max(160),
  request_id: z.string().min(1).max(160),
  request_digest: digest,
  operation: z.enum(["remember", "correct", "forget", "export"]),
  subject: z.string().min(1).max(512),
  purpose: z.enum(["personal_memory", "data_erasure", "data_portability"]),
  sensitivity,
  retention_days: z.number().int().min(1).max(3_650),
  created_at: instant,
  expires_at: instant,
  expected_prior: v1Prior.nullable(),
  receipt: v1Receipt,
  receipt_digest: digest,
  payload: v1Payload,
}).strict();

export const ResolvedMemoryTargetSchema = z.object({
  schema_version: z.literal(1),
  target_id: z.string().regex(/^sbtarget:v1:[0-9a-f]{64}$/),
  target_digest: digest,
  provider_instance_id: z.string().min(1).max(128),
  generation_id: z.string().min(1).max(160),
  generation_manifest_digest: digest,
  vault_head: z.string().regex(/^[0-9a-f]{40}$/),
  vault_tree: z.string().regex(/^[0-9a-f]{40}$/),
  page_id: z.string().min(1).max(512),
  page_blob_oid: z.string().regex(/^[0-9a-f]{40}$/),
  page_content_digest: digest,
  source_identity_full: fullIdentity,
  content_identity_full: fullIdentity,
  citation_identity_full: fullIdentity,
  citation_span_start: safeInteger,
  citation_span_end: safeInteger,
  subject_digest: digest,
  sensitivity,
  valid_from: instant,
  valid_until: instant,
  source_owner_class: ownerClass,
  source_owner_id_digest: digest,
  resolved_at: instant,
  expires_at: instant,
}).strict();
export const MemoryEffectScopeSchema = z.object({
  format: z.enum(["none", "json"]),
  sensitivity_classes: z.array(sensitivity).min(1).max(4),
  valid_from: instant,
  valid_until: instant,
  max_records: z.number().int().min(1).max(64),
  max_bytes: z.number().int().min(1).max(1_048_576),
  source_owner_classes: z.array(ownerClass).min(1).max(2),
}).strict();
export const MemoryEffectExpectedPriorSchema = z.object({
  provider_instance_id: z.string().min(1).max(128),
  generation_id: z.string().min(1).max(160),
  generation_manifest_digest: digest,
  vault_head: z.string().regex(/^[0-9a-f]{40}$/),
  vault_tree: z.string().regex(/^[0-9a-f]{40}$/),
  page_blob_oid: z.string().regex(/^[0-9a-f]{40}$/),
  page_content_digest: digest,
  citation_identity_full: fullIdentity,
}).strict();
export const MemoryTombstoneHighWaterSchema = z.object({
  sequence: safeInteger,
  set_root: digest,
}).strict();
export const MemoryTombstoneChainEntrySchema = z.object({
  sequence: safeInteger,
  tombstone_id: z.string().regex(/^memtomb:v1:[0-9a-f]{64}$/),
  operation: z.enum(["correct", "forget"]),
  lane_id: z.string().min(1).max(160),
  target_manifest_digest: digest,
  scope_digest: digest,
  authority_receipt_digest: digest,
  payload_digest: digest,
  keyed_subject_digest: z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/),
  effective_at: instant,
  previous_root: digest,
  set_root: digest,
}).strict();
const externalReceipt = z.object({
  owner_id_digest: digest,
  receipt_id: z.string().regex(/^exterase:v1:[0-9a-f]{64}$/),
  receipt_digest: digest,
  scope_digest: digest,
  deleted_at: instant,
  signing_key_id: z.string().min(1).max(128),
  signature,
}).strict();
export const MemoryCorrectionPayloadSchema = z.object({
  content: z.string().min(1).max(4_096),
  content_digest: digest,
  content_bytes: z.number().int().min(1).max(4_096),
  disposition: z.literal("superseded"),
}).strict();
export const MemoryDeletionPayloadSchema = z.object({
  disposition: z.literal("owner_requested"),
  erasure_claim: z.enum(["managed_erasure", "provider_local_suppression"]),
  external_receipts: z.array(externalReceipt).max(16),
}).strict();
export const MemoryExportPayloadSchema = z.object({
  format: z.literal("json"),
  target_record_ids: z.array(z.string().regex(/^sbtarget:v1:[0-9a-f]{64}$/)).min(1).max(64),
  sensitivity_classes: z.array(sensitivity).min(1).max(4),
  valid_from: instant,
  valid_until: instant,
  max_records: z.number().int().min(1).max(64),
  max_bytes: z.number().int().min(1).max(1_048_576),
}).strict();
export const MemoryEffectDelegationSchema = z.object({
  schema_version: z.literal(1),
  delegation_id: z.string().regex(/^memdeleg:v1:[0-9a-f]{64}$/),
  delegation_digest: digest,
  provider_instance_id: z.string().min(1).max(128),
  purpose: z.enum(["memory_correction", "memory_delete", "memory_export"]),
  operation: z.enum(["correct", "forget", "export"]),
  lane_id: z.string().min(1).max(160),
  request_id: z.string().regex(/^memeff:req:v2:[0-9a-f]{64}$/),
  request_digest: digest,
  payload_digest: digest,
  target_manifest_digest: digest,
  scope_digest: digest,
  expected_prior: MemoryEffectExpectedPriorSchema,
  tombstone_sequence: safeInteger,
  tombstone_set_root: digest,
  principal_id: z.literal("principal:owner"),
  issued_at: instant,
  not_before: instant,
  expires_at: instant,
  nonce: z.string().min(1).max(128),
  max_uses: z.literal(1),
  signing_key_id: z.string().min(1).max(128),
  signature,
}).strict();
export const MemoryEffectWriteRequestV2Schema = z.object({
  schema_version: z.literal(2),
  kind: z.literal("memory_effect"),
  provider_instance_id: z.string().min(1).max(128),
  lane: z.enum(["correction", "deletion", "export"]),
  lane_id: z.string().min(1).max(160),
  operation: z.enum(["correct", "forget", "export"]),
  request_id: z.string().regex(/^memeff:req:v2:[0-9a-f]{64}$/),
  request_digest: digest,
  idempotency_key: z.string().regex(/^memeff:idem:v2:[0-9a-f]{64}$/),
  envelope_digest: digest,
  target_manifest_digest: digest,
  targets: z.array(ResolvedMemoryTargetSchema).min(1).max(64),
  scope: MemoryEffectScopeSchema,
  scope_digest: digest,
  expected_prior: MemoryEffectExpectedPriorSchema,
  tombstone_high_water: MemoryTombstoneHighWaterSchema,
  tombstone_chain_delta: z.array(MemoryTombstoneChainEntrySchema).max(256),
  delegation: MemoryEffectDelegationSchema,
  created_at: instant,
  expires_at: instant,
  payload: z.union([MemoryCorrectionPayloadSchema, MemoryDeletionPayloadSchema, MemoryExportPayloadSchema]),
}).strict();

export const MemoryWriteRequestV3Schema = MemoryWriteRequestV1Schema.extend({
  schema_version: z.literal(3), body_profile: z.literal("plain-text-v1"), operation: z.literal("remember"),
  purpose: z.literal("personal_memory"), expected_prior: z.null(),
  payload: z.object({ content: z.string().min(1).max(4_096) }).strict(),
}).strict();

export const MemoryWriteRequestSchema = z.discriminatedUnion("schema_version", [
  MemoryWriteRequestV1Schema,
  MemoryEffectWriteRequestV2Schema,
  MemoryWriteRequestV3Schema,
]);
