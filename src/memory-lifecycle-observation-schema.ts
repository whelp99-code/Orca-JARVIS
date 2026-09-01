import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const providerEntry = z.object({
  catalog_key: z.templateLiteral(["surface:", z.number().int().min(1).max(40)]),
  owner: z.enum(["second_brain", "exports"]),
  surface_id: z.string().min(1).max(128),
  applicable: z.boolean(),
  readable: z.boolean(),
  manifest_digest: digest,
  file_count: count,
  row_count: count,
  object_count: count,
  fd_count: count,
  match_count: count,
  error_count: count,
  omission_count: count,
  scan_digest: digest,
  errors: z.array(z.string().min(1).max(128)).max(64),
}).strict();
const guardEntry = z.object({
  guard_id: z.string().min(1).max(128),
  applicable: z.boolean(),
  executed: z.boolean(),
  blocked: z.boolean(),
  error_code: z.string().min(1).max(128).nullable(),
  execution_count: z.number().int().min(0).max(1),
  error_count: z.number().int().min(0).max(1),
  omission_count: z.number().int().min(0).max(1),
  observation_digest: digest,
}).strict();

export const ProviderSurfaceInventorySchema = z.object({
  schema_version: z.literal(1),
  catalog_digest: digest,
  manifest_digest: digest,
  expected_surface_count: z.literal(40),
  observed_surface_count: z.literal(40),
  omission_count: count,
  error_count: count,
  match_count: count,
  entries: z.array(providerEntry).length(40),
}).strict();

export const ReingressGuardObservationsSchema = z.object({
  schema_version: z.literal(1),
  catalog_digest: digest,
  manifest_digest: digest,
  expected_guard_count: z.literal(10),
  observed_guard_count: z.literal(10),
  error_count: count,
  omission_count: count,
  entries: z.array(guardEntry).length(10),
}).strict();

const surfaceManifest = z.object({
  schema_version: z.literal(1),
  manifest_digest: digest,
  provider_instance_id: z.string().min(1).max(128),
  generation_id: z.string().min(1).max(160),
  generation_manifest_digest: digest,
  vault_head: z.string().regex(/^[0-9a-f]{40}$/),
  vault_tree: z.string().regex(/^[0-9a-f]{40}$/),
  tombstone_sequence: count,
  tombstone_set_root: digest,
  provider_inventory: ProviderSurfaceInventorySchema,
  reingress_guards: ReingressGuardObservationsSchema,
  created_at: z.iso.datetime({ offset: false, precision: 3 }),
}).strict();
const artifact = z.object({
  manifest_digest: digest,
  target_manifest_digest: digest,
  generation_id: z.string().min(1).max(160),
  file_digest: digest,
  file_count: z.literal(1),
  byte_count: z.number().int().positive(),
  match_count: z.literal(1),
  scan_digest: digest,
}).strict();
const absence = z.object({
  surface_manifest_digest: digest,
  target_manifest_digest: digest,
  match_count: z.literal(0),
  error_count: z.literal(0),
  omission_count: z.literal(0),
  scan_digest: digest,
}).strict();
const exportObservation = z.object({
  manifest_digest: digest,
  file_count: z.number().int().positive(),
  byte_count: z.number().int().positive(),
  record_count: z.number().int().positive(),
  scan_digest: digest,
}).strict();

export const MemoryLifecycleObservationManifestSchema = z.object({
  schema_version: z.literal(1),
  observation_digest: digest,
  request_id: z.string().regex(/^memeff:req:v2:[0-9a-f]{64}$/),
  operation: z.enum(["correct", "forget", "export"]),
  surface_manifest: surfaceManifest,
  artifact: artifact.nullable(),
  absence: absence.nullable(),
  export: exportObservation.nullable(),
}).strict();
