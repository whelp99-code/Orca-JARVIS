import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import {
  MEMORY_MANAGED_SURFACE_CATALOG,
  MEMORY_PROVIDER_SURFACE_CATALOG_DIGEST,
} from "./memory-managed-surface-catalog.js";
import {
  MemoryLifecycleObservationManifestSchema,
  ProviderSurfaceInventorySchema,
  ReingressGuardObservationsSchema,
} from "./memory-lifecycle-observation-schema.js";

const GUARD_PROBES = [
  ["sb_remember", "content"], ["legacy_stable_import", "identity"],
  ["inbox_done", "content"], ["all_connectors", "identity"],
  ["compile_brief", "content"], ["manual_pipeline", "content"],
  ["export", "identity"], ["backup_import_restore_rollback", "content"],
  ["duplicate_alias", "identity"], ["stale_process_generation", "identity"],
] as const;
const GUARD_CATALOG_DIGEST = hash("second-brain/memory-surface-manifest/v1\0", {
  guards: GUARD_PROBES.map(([guard_id, probe]) => ({ guard_id, probe })),
});

export type MemoryLifecycleObservationBinding = {
  readonly request_id: string;
  readonly operation: "correct" | "forget" | "export";
  readonly provider_instance_id: string;
  readonly target_manifest_digest: string;
  readonly result_generation_id: string;
  readonly result_head: string;
  readonly result_tree: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
  readonly surface_manifest_digest: string;
  readonly artifact_manifest_digest: string | null;
  readonly export_manifest_digest: string | null;
};

export type ProviderSurfaceObservation = {
  readonly catalog_key: `surface:${number}`;
  readonly owner: "second_brain" | "exports";
  readonly surface_id: string;
  readonly applicable: boolean;
  readonly readable: boolean;
  readonly manifest_digest: string;
  readonly file_count: number;
  readonly row_count: number;
  readonly object_count: number;
  readonly fd_count: number;
  readonly match_count: number;
  readonly error_count: number;
  readonly omission_count: number;
  readonly scan_digest: string;
  readonly errors: readonly string[];
};

export type CompleteProviderSurfaceInventory = {
  readonly schema_version: 1;
  readonly catalog_digest: string;
  readonly manifest_digest: string;
  readonly expected_surface_count: 40;
  readonly observed_surface_count: 40;
  readonly omission_count: number;
  readonly error_count: number;
  readonly match_count: number;
  readonly entries: readonly ProviderSurfaceObservation[];
};

export type ReingressGuardObservation = {
  readonly guard_id: string;
  readonly applicable: boolean;
  readonly executed: boolean;
  readonly blocked: boolean;
  readonly error_code: string | null;
  readonly execution_count: number;
  readonly error_count: number;
  readonly omission_count: number;
  readonly observation_digest: string;
};

export type CompleteReingressGuardObservations = {
  readonly schema_version: 1;
  readonly catalog_digest: string;
  readonly manifest_digest: string;
  readonly expected_guard_count: 10;
  readonly observed_guard_count: 10;
  readonly error_count: number;
  readonly omission_count: number;
  readonly entries: readonly ReingressGuardObservation[];
};

export type MemoryLifecycleObservedResult =
  | { readonly kind: "correction"; readonly artifact_manifest_digest: string;
      readonly target_manifest_digest: string; readonly file_count: 1;
      readonly byte_count: number; readonly artifact_match_count: 1;
      readonly absence_match_count: 0 }
  | { readonly kind: "deletion"; readonly absence_manifest_digest: string;
      readonly target_manifest_digest: string; readonly scanned_surface_count: 40;
      readonly match_count: 0; readonly error_count: 0; readonly omission_count: 0 }
  | { readonly kind: "export"; readonly export_manifest_digest: string;
      readonly file_count: number; readonly byte_count: number;
      readonly record_count: number };

export type ParsedMemoryLifecycleObservationManifest = {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly operation: "correct" | "forget" | "export";
  readonly observation_digest: string;
  readonly observed_at: string;
  readonly generation_manifest_digest: string;
  readonly provider_inventory: CompleteProviderSurfaceInventory;
  readonly reingress_guards: CompleteReingressGuardObservations;
  readonly result: MemoryLifecycleObservedResult;
};

export interface MemoryLifecycleObservationSource {
  observe(binding: MemoryLifecycleObservationBinding): Promise<ParsedMemoryLifecycleObservationManifest>;
}

export function parseMemoryLifecycleObservationManifest(
  value: unknown,
  expected: MemoryLifecycleObservationBinding,
): ParsedMemoryLifecycleObservationManifest {
  const parsed = MemoryLifecycleObservationManifestSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_INVALID");
  const observed = parsed.data;
  const surface = observed.surface_manifest;
  if (observed.request_id !== expected.request_id || observed.operation !== expected.operation
    || surface.provider_instance_id !== expected.provider_instance_id
    || surface.generation_id !== expected.result_generation_id
    || surface.vault_head !== expected.result_head || surface.vault_tree !== expected.result_tree
    || surface.tombstone_sequence !== expected.tombstone_sequence
    || surface.tombstone_set_root !== expected.tombstone_set_root
    || surface.manifest_digest !== expected.surface_manifest_digest
    || surface.manifest_digest !== hash("second-brain/memory-surface-manifest/v1\0",
      without(surface, "manifest_digest"))
    || observed.observation_digest !== hash("second-brain/memory-surface-manifest/v1\0",
      without(observed, "observation_digest"))) {
    throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
  }
  const provider = parseCompleteProviderSurfaceInventory(surface.provider_inventory);
  const guards = parseCompleteReingressGuardObservations(surface.reingress_guards);
  return { schema_version: 1, request_id: observed.request_id, operation: observed.operation,
    observation_digest: observed.observation_digest, observed_at: surface.created_at,
    generation_manifest_digest: surface.generation_manifest_digest,
    provider_inventory: provider, reingress_guards: guards,
    result: observedResult(observed, expected) };
}

export function parseCompleteProviderSurfaceInventory(
  value: unknown,
): CompleteProviderSurfaceInventory {
  const parsed = ProviderSurfaceInventorySchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
  const inventory = parsed.data;
  const definitions = MEMORY_MANAGED_SURFACE_CATALOG.slice(0, 40);
  const validRows = inventory.entries.every((entry, index) => {
    const definition = definitions[index];
    return definition !== undefined && entry.catalog_key === definition.catalog_key
      && entry.owner === definition.owner && entry.surface_id === definition.surface_id
      && entry.readable && entry.match_count === 0
      && entry.error_count === 0 && entry.omission_count === 0 && entry.errors.length === 0;
  });
  const observedObjects = inventory.entries.reduce((total, entry) => total + entry.file_count
    + entry.row_count + entry.object_count + entry.fd_count, 0);
  if (!validRows || observedObjects === 0
    || inventory.catalog_digest !== MEMORY_PROVIDER_SURFACE_CATALOG_DIGEST
    || inventory.error_count !== 0 || inventory.omission_count !== 0 || inventory.match_count !== 0
    || inventory.manifest_digest !== hash("second-brain/memory-surface-manifest/v1\0",
      without(inventory, "manifest_digest"))) {
    throw new JarvisError("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
  }
  return Object.freeze({ ...inventory, entries: Object.freeze([...inventory.entries]) });
}

export function parseCompleteReingressGuardObservations(
  value: unknown,
): CompleteReingressGuardObservations {
  const parsed = ReingressGuardObservationsSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MEMORY_REINGRESS_GUARD_OBSERVATION_INVALID");
  const guards = parsed.data;
  const valid = guards.entries.every((entry, index) => entry.guard_id === GUARD_PROBES[index]?.[0]
    && entry.applicable && entry.executed && entry.blocked
    && entry.error_code === "TOMBSTONE_REINGRESS_BLOCKED"
    && entry.execution_count === 1 && entry.error_count === 0 && entry.omission_count === 0
    && entry.observation_digest === hash("second-brain/memory-surface-manifest/v1\0",
      without(entry, "observation_digest")));
  if (!valid || guards.catalog_digest !== GUARD_CATALOG_DIGEST
    || guards.error_count !== 0 || guards.omission_count !== 0
    || guards.manifest_digest !== hash("second-brain/memory-surface-manifest/v1\0",
      without(guards, "manifest_digest"))) {
    throw new JarvisError("MEMORY_REINGRESS_GUARD_OBSERVATION_INVALID");
  }
  return Object.freeze({ ...guards, entries: Object.freeze([...guards.entries]) });
}

function observedResult(
  observed: ReturnType<typeof MemoryLifecycleObservationManifestSchema.parse>,
  expected: MemoryLifecycleObservationBinding,
): MemoryLifecycleObservedResult {
  const artifact = observed.artifact;
  const absence = observed.absence;
  const exported = observed.export;
  switch (observed.operation) {
    case "correct":
      if (artifact === null || absence === null || exported !== null
        || artifact.manifest_digest !== expected.artifact_manifest_digest
        || artifact.target_manifest_digest !== expected.target_manifest_digest
        || artifact.generation_id !== expected.result_generation_id
        || artifact.manifest_digest !== hash("second-brain/memory-surface-manifest/v1\0",
          without(artifact, "manifest_digest"))
        || absence.surface_manifest_digest !== expected.surface_manifest_digest
        || absence.target_manifest_digest !== expected.target_manifest_digest) {
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      }
      return { kind: "correction", artifact_manifest_digest: artifact.manifest_digest,
        target_manifest_digest: artifact.target_manifest_digest, file_count: artifact.file_count,
        byte_count: artifact.byte_count, artifact_match_count: artifact.match_count,
        absence_match_count: absence.match_count };
    case "forget":
      if (artifact !== null || absence === null || exported !== null
        || absence.surface_manifest_digest !== expected.surface_manifest_digest
        || absence.target_manifest_digest !== expected.target_manifest_digest) {
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      }
      return { kind: "deletion", absence_manifest_digest: absence.surface_manifest_digest,
        target_manifest_digest: absence.target_manifest_digest, scanned_surface_count: 40,
        match_count: absence.match_count, error_count: absence.error_count,
        omission_count: absence.omission_count };
    case "export":
      if (artifact !== null || absence !== null || exported === null
        || exported.manifest_digest !== expected.export_manifest_digest) {
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      }
      return { kind: "export", export_manifest_digest: exported.manifest_digest,
        file_count: exported.file_count, byte_count: exported.byte_count,
        record_count: exported.record_count };
    default:
      return assertNever(observed.operation);
  }
}

function without(value: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function hash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}

function assertNever(value: never): never {
  throw new JarvisError(`MEMORY_LIFECYCLE_OBSERVATION_INVALID:${String(value)}`);
}
