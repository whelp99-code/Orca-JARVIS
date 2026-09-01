import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { ExportObservation } from "./memory-lifecycle-observation-schema.js";

const EXPORT_MANIFEST_DOMAIN = "second-brain/memory-export-manifest/v1\0";
const SURFACE_MANIFEST_DOMAIN = "second-brain/memory-surface-manifest/v1\0";

type ExportObservationBinding = {
  readonly request_id: string;
  readonly provider_instance_id: string;
  readonly result_generation_id: string;
  readonly result_head: string;
  readonly result_tree: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
  readonly export_manifest_digest: string | null;
};

export type VerifiedExportObservation = {
  readonly kind: "export";
  readonly export_manifest_digest: string;
  readonly file_count: number;
  readonly byte_count: number;
  readonly record_count: number;
};

export function verifyExportObservation(
  exported: ExportObservation,
  expected: ExportObservationBinding,
): VerifiedExportObservation {
  const manifest = exported.manifest;
  const manifestBody = Object.fromEntries(Object.entries(manifest)
    .filter(([name]) => name !== "manifest_id" && name !== "manifest_digest"));
  const manifestDigest = hash(EXPORT_MANIFEST_DOMAIN, manifestBody);
  const fileCount = manifest.files.length;
  const byteCount = manifest.files.reduce((total, file) => total + file.bytes, 0);
  const scanDigest = hash(SURFACE_MANIFEST_DOMAIN, {
    files: manifest.files.map(file => ({
      file_digest: file.digest,
      byte_count: file.bytes,
      mode: file.mode,
    })),
    record_count: manifest.record_count,
  });
  if (manifest.manifest_digest !== manifestDigest
    || manifest.manifest_id !== `sbexport:v1:${manifestDigest.slice(7)}`
    || exported.manifest_digest !== manifestDigest
    || expected.export_manifest_digest !== manifestDigest
    || manifest.request_id !== expected.request_id
    || manifest.provider_instance_id !== expected.provider_instance_id
    || manifest.generation_id !== expected.result_generation_id
    || manifest.vault_head !== expected.result_head
    || manifest.vault_tree !== expected.result_tree
    || manifest.tombstone_sequence !== expected.tombstone_sequence
    || manifest.tombstone_set_root !== expected.tombstone_set_root
    || manifest.data_bytes !== byteCount
    || exported.file_count !== fileCount
    || exported.byte_count !== byteCount
    || exported.record_count !== manifest.record_count
    || exported.scan_digest !== scanDigest) {
    throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
  }
  return { kind: "export", export_manifest_digest: manifestDigest,
    file_count: fileCount, byte_count: byteCount, record_count: manifest.record_count };
}

function hash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}
