import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import {
  parseMemoryLifecycleObservationManifest,
  type MemoryLifecycleObservationBinding,
} from "../../src/memory-lifecycle-observation-manifest.js";
import {
  providerSurfaceInventory,
  reingressGuardObservations,
} from "../fixtures/memory-surface-observations.js";

const hash = (value: unknown): string => `sha256:${createHash("sha256")
  .update("second-brain/memory-surface-manifest/v1\0")
  .update(canonicalize(value)).digest("hex")}`;
const targetManifestDigest = `sha256:${"2".repeat(64)}`;
const exportManifestDigest = `sha256:${"4".repeat(64)}`;
const requestId = `memeff:req:v2:${"5".repeat(64)}`;
const providerId = "provider:test";
const generationId = `sbgen:v1:${"6".repeat(64)}`;
const generationManifestDigest = `sha256:${"7".repeat(64)}`;
const head = "8".repeat(40);
const tree = "9".repeat(40);
const tombstoneRoot = `sha256:${"a".repeat(64)}`;

function fixture(operation: "correct" | "forget" | "export", allZero = false): {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly binding: MemoryLifecycleObservationBinding;
} {
  const observedProvider = providerSurfaceInventory();
  const provider = allZero ? (() => {
    const entries = observedProvider.entries.map(entry => ({ ...entry,
      file_count: 0, row_count: 0, object_count: 0, fd_count: 0 }));
    const body = { ...observedProvider, entries };
    const unsigned = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "manifest_digest"));
    return { ...unsigned, manifest_digest: hash(unsigned) };
  })() : observedProvider;
  const surfaceBody = { schema_version: 1, provider_instance_id: providerId,
    generation_id: generationId, generation_manifest_digest: generationManifestDigest,
    vault_head: head, vault_tree: tree, tombstone_sequence: 1,
    tombstone_set_root: tombstoneRoot, provider_inventory: provider,
    reingress_guards: reingressGuardObservations(), created_at: "2026-08-31T00:00:04.000Z" };
  const surfaceManifest = { ...surfaceBody, manifest_digest: hash(surfaceBody) };
  const artifactBody = { target_manifest_digest: targetManifestDigest,
    generation_id: generationId, file_digest: `sha256:${"b".repeat(64)}`,
    file_count: 1, byte_count: 8_192, match_count: 1,
    scan_digest: `sha256:${"c".repeat(64)}` };
  const artifact = { ...artifactBody, manifest_digest: hash(artifactBody) };
  const absence = { surface_manifest_digest: surfaceManifest.manifest_digest,
    target_manifest_digest: targetManifestDigest, match_count: 0, error_count: 0,
    omission_count: 0, scan_digest: `sha256:${"d".repeat(64)}` };
  const exported = { manifest_digest: exportManifestDigest, file_count: 3,
    byte_count: 12_288, record_count: 2, scan_digest: `sha256:${"e".repeat(64)}` };
  const body = { schema_version: 1, request_id: requestId, operation,
    surface_manifest: surfaceManifest,
    artifact: operation === "correct" ? artifact : null,
    absence: operation === "correct" || operation === "forget" ? absence : null,
    export: operation === "export" ? exported : null };
  return {
    manifest: { ...body, observation_digest: hash(body) },
    binding: { request_id: requestId, operation, provider_instance_id: providerId,
      target_manifest_digest: targetManifestDigest, result_generation_id: generationId,
      result_head: head, result_tree: tree, tombstone_sequence: 1,
      tombstone_set_root: tombstoneRoot,
      surface_manifest_digest: surfaceManifest.manifest_digest,
      artifact_manifest_digest: operation === "correct" ? artifact.manifest_digest : null,
      export_manifest_digest: operation === "export" ? exportManifestDigest : null },
  };
}

describe("closed lifecycle observation manifest", () => {
  it("rejects proof digests used as artifact, absence, inventory, and guard observations", () => {
    // Given: the old digest-only JARVIS observation shape.
    const value = { schema_version: 1, request_id: requestId,
      provider_inventory: { manifest_digest: `sha256:${"1".repeat(64)}`,
        catalog_rows: 40, signature_verified: true },
      reingress_guards: { sb_remember: `sha256:${"1".repeat(64)}` },
      result: { kind: "correction", artifact_manifest_digest: `sha256:${"1".repeat(64)}` } };
    const expected = fixture("correct").binding;

    // When/Then: the closed boundary rejects manufactured safety facts.
    expect(() => parseMemoryLifecycleObservationManifest(value, expected))
      .toThrow("MEMORY_LIFECYCLE_OBSERVATION_INVALID");
  });

  it("rejects forty provider rows whose physical counters are all zero", () => {
    // Given: a structurally complete but observation-free provider manifest.
    const value = fixture("forget", true);

    // When/Then: catalog expansion cannot substitute for physical observations.
    expect(() => parseMemoryLifecycleObservationManifest(value.manifest, value.binding))
      .toThrow("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
  });

  it("preserves externally observed export counts instead of hardcoding one byte and one file", () => {
    // Given: a closed export observation with non-default measured counts.
    const value = fixture("export");

    // When: the provider integration seam parses the machine manifest.
    const parsed = parseMemoryLifecycleObservationManifest(value.manifest, value.binding);

    // Then: the exact observed values survive the boundary.
    expect(parsed.result).toEqual({ kind: "export", export_manifest_digest: exportManifestDigest,
      file_count: 3, byte_count: 12_288, record_count: 2 });
  });
});
