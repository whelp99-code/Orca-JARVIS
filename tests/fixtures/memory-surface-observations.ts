import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import type {
  CompleteProviderSurfaceInventory,
  CompleteReingressGuardObservations,
} from "../../src/memory-lifecycle-observation-manifest.js";
import {
  MEMORY_MANAGED_SURFACE_CATALOG,
  MEMORY_PROVIDER_SURFACE_CATALOG_DIGEST,
} from "../../src/memory-managed-surface-catalog.js";

const GUARDS = [
  ["sb_remember", "content"], ["legacy_stable_import", "identity"],
  ["inbox_done", "content"], ["all_connectors", "identity"],
  ["compile_brief", "content"], ["manual_pipeline", "content"],
  ["export", "identity"], ["backup_import_restore_rollback", "content"],
  ["duplicate_alias", "identity"], ["stale_process_generation", "identity"],
] as const;
const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update("second-brain/memory-surface-manifest/v1\0")
  .update(canonicalize(value)).digest("hex")}`;
const observedDigest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`;

export function providerSurfaceInventory(): CompleteProviderSurfaceInventory {
  const entries = MEMORY_MANAGED_SURFACE_CATALOG.slice(0, 40).map((definition, index) => {
    if (definition.owner !== "second_brain" && definition.owner !== "exports") {
      throw new Error("PROVIDER_SURFACE_FIXTURE_INVALID");
    }
    return { catalog_key: definition.catalog_key, owner: definition.owner,
      surface_id: definition.surface_id, applicable: true, readable: true,
      manifest_digest: observedDigest(index + 1), file_count: index === 0 ? 1 : 0,
      row_count: index === 18 ? 1 : 0, object_count: index === 28 ? 1 : 0,
      fd_count: 0, match_count: 0, error_count: 0, omission_count: 0,
      scan_digest: observedDigest(index + 41), errors: [] };
  });
  const body = { schema_version: 1 as const,
    catalog_digest: MEMORY_PROVIDER_SURFACE_CATALOG_DIGEST,
    expected_surface_count: 40 as const, observed_surface_count: 40 as const,
    omission_count: 0, error_count: 0, match_count: 0, entries };
  return { ...body, manifest_digest: digest(body) };
}

export function reingressGuardObservations(): CompleteReingressGuardObservations {
  const entries = GUARDS.map(([guardId]) => {
    const body = { guard_id: guardId, applicable: true, executed: true, blocked: true,
      error_code: "TOMBSTONE_REINGRESS_BLOCKED", execution_count: 1,
      error_count: 0, omission_count: 0 };
    return { ...body, observation_digest: digest(body) };
  });
  const catalogDigest = digest({ guards: GUARDS.map(([guard_id, probe]) => ({ guard_id, probe })) });
  const body = { schema_version: 1 as const, catalog_digest: catalogDigest,
    expected_guard_count: 10 as const, observed_guard_count: 10 as const,
    error_count: 0, omission_count: 0, entries };
  return { ...body, manifest_digest: digest(body) };
}
