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

const domainHash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
const hash = (value: unknown): string => domainHash(
  "second-brain/memory-surface-manifest/v1\0", value,
);
const targetManifestDigest = `sha256:${"2".repeat(64)}`;
const requestId = `memeff:req:v2:${"5".repeat(64)}`;
const providerId = "provider:test";
const generationId = `sbgen:v1:${"6".repeat(64)}`;
const generationManifestDigest = `sha256:${"7".repeat(64)}`;
const head = "8".repeat(40);
const tree = "9".repeat(40);
const tombstoneRoot = `sha256:${"a".repeat(64)}`;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("export observation fixture must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

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
  const exportFile = { name: "memory.json", digest: `sha256:${"e".repeat(64)}`,
    mode: 384, bytes: 542 };
  const exportManifestBody = { schema_version: 1, request_id: requestId,
    request_digest: `sha256:${"f".repeat(64)}`,
    delegation_id: `memdeleg:v1:${"1".repeat(64)}`,
    delegation_digest: `sha256:${"2".repeat(64)}`,
    scope_digest: `sha256:${"3".repeat(64)}`, provider_instance_id: providerId,
    provider_release_sha: "4".repeat(40), generation_id: generationId,
    vault_head: head, vault_tree: tree, tombstone_sequence: 1,
    tombstone_set_root: tombstoneRoot, target_ids: [`sbtarget:v1:${"5".repeat(64)}`],
    source_identities: ["6".repeat(64)], content_identities: ["7".repeat(64)],
    citation_identities: ["8".repeat(64)], sensitivity_classes: ["personal"],
    valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z",
    record_count: 1, data_bytes: 542, files: [exportFile],
    created_at: "2026-08-31T00:00:03.000Z", expires_at: "2026-09-01T00:00:03.000Z" };
  const exportManifestDigest = domainHash(
    "second-brain/memory-export-manifest/v1\0", exportManifestBody,
  );
  const exportManifest = { ...exportManifestBody,
    manifest_id: `sbexport:v1:${exportManifestDigest.slice(7)}`,
    manifest_digest: exportManifestDigest };
  const exportScan = hash({ files: [{ file_digest: exportFile.digest,
    byte_count: exportFile.bytes, mode: exportFile.mode }], record_count: 1 });
  const exported = { manifest_digest: exportManifestDigest, manifest: exportManifest,
    file_count: 1, byte_count: 542, record_count: 1, scan_digest: exportScan };
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

  it("derives export counts from the signed closed manifest", () => {
    // Given: a closed export observation with the provider's exact manifest shape.
    const value = fixture("export");

    // When: the provider integration seam parses the machine manifest.
    const parsed = parseMemoryLifecycleObservationManifest(value.manifest, value.binding);

    // Then: only manifest-derived values survive the boundary.
    expect(parsed.result).toEqual({ kind: "export",
      export_manifest_digest: value.binding.export_manifest_digest,
      file_count: 1, byte_count: 542, record_count: 1 });
  });

  it("rejects rehashed export counts that differ from the signed export manifest", () => {
    // Given: the exact v4 count mutation with the signed manifest digest unchanged.
    const value = fixture("export");
    const exported = record(value.manifest["export"]);
    const changed = { ...value.manifest, export: { ...exported,
      file_count: Number(exported["file_count"]) + 1,
      byte_count: Number(exported["byte_count"]) + 7,
      record_count: Number(exported["record_count"]) + 1 } };
    const unsigned = Object.fromEntries(Object.entries(changed)
      .filter(([key]) => key !== "observation_digest"));
    const mutation = { ...unsigned, observation_digest: hash(unsigned) };

    // When/Then: rehashing the unsigned outer observation cannot preserve acceptance.
    expect(() => parseMemoryLifecycleObservationManifest(mutation, value.binding))
      .toThrow("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
  });

  it("rejects a rehashed manifest entry while the signed proof digest stays unchanged", () => {
    // Given: one file entry, nested manifest, and outer observation all rehashed by an attacker.
    const value = fixture("export");
    const exported = record(value.manifest["export"]);
    const manifest = record(exported["manifest"]);
    const files = manifest["files"];
    if (!Array.isArray(files) || files.length !== 1) {
      throw new TypeError("export manifest fixture must contain one file");
    }
    const file = record(files[0]);
    const changedManifest = { ...manifest,
      data_bytes: Number(manifest["data_bytes"]) + 7,
      files: [{ ...file, bytes: Number(file["bytes"]) + 7 }] };
    const manifestBody = Object.fromEntries(Object.entries(changedManifest)
      .filter(([key]) => key !== "manifest_id" && key !== "manifest_digest"));
    const changedDigest = domainHash("second-brain/memory-export-manifest/v1\0", manifestBody);
    const closedManifest = { ...manifestBody,
      manifest_id: `sbexport:v1:${changedDigest.slice(7)}`,
      manifest_digest: changedDigest };
    const changed = { ...value.manifest, export: { ...exported,
      manifest_digest: changedDigest, manifest: closedManifest,
      byte_count: Number(exported["byte_count"]) + 7 } };
    const unsigned = Object.fromEntries(Object.entries(changed)
      .filter(([key]) => key !== "observation_digest"));
    const mutation = { ...unsigned, observation_digest: hash(unsigned) };

    // When/Then: the provider-signed original digest remains the sole authority.
    expect(() => parseMemoryLifecycleObservationManifest(mutation, value.binding))
      .toThrow("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
  });
});
