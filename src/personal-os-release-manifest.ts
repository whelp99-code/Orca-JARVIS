import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { canonicalize } from "./canonical.js";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";

export const MANIFEST_NAME = "release.manifest.json" as const;
const PAYLOAD_DOMAIN = "orca-jarvis/task36-payload-entries/v1\0";

export type ReleaseArtifact = "jarvis-authority" | "second-brain-provider";

export type ManifestEntry = {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly sha256: string | null;
  readonly target: string | null;
};

export type ReleaseSource = {
  readonly commit: string;
  readonly tree: string;
  readonly first_parent: string;
  readonly subject: string;
  readonly commit_timestamp: string;
  readonly archive_digest: string;
};

export type ReleaseBuild = {
  readonly source_date_epoch: number;
  readonly builder_command: string;
  readonly offline_cache_digest: string;
  readonly lifecycle_command_digests: readonly string[];
  readonly reproducibility_receipt: string;
};

export type ReleaseManifest = {
  readonly schema_version: 1;
  readonly artifact: ReleaseArtifact;
  readonly source: ReleaseSource;
  readonly build: ReleaseBuild;
  readonly entries: readonly ManifestEntry[];
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly payload_digest: string;
  readonly self_exclusion: { readonly path: typeof MANIFEST_NAME; readonly count: 1 };
};

export type ManifestInput = {
  readonly root: string;
  readonly artifact: ReleaseArtifact;
  readonly source: ReleaseSource;
  readonly build: ReleaseBuild;
};

function walk(root: string, dir: string, entries: ManifestEntry[], excludeManifest: boolean): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join("/");
    const stat = lstatSync(full);
    if (excludeManifest && dir === root && name === MANIFEST_NAME) {
      if (stat.isSymbolicLink()) throw new PersonalOsError("E_UNSAFE_SYMLINK");
      if (!stat.isFile()) throw new PersonalOsError("E_STAGE_INVALID");
      continue;
    }
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      entries.push({ path: rel, type: "directory", mode, size: 0, sha256: null, target: null });
      walk(root, full, entries, excludeManifest);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full);
      const normalized = normalize(join(dirname(rel), target));
      if (isAbsolute(target) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
        throw new PersonalOsError("E_UNSAFE_SYMLINK");
      }
      entries.push({ path: rel, type: "symlink", mode, size: Buffer.byteLength(target), sha256: null, target });
      continue;
    }
    if (!stat.isFile()) throw new PersonalOsError("E_STAGE_INVALID");
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    entries.push({ path: rel, type: "file", mode, size: stat.size, sha256, target: null });
  }
}

export function runtimeDependencyIdentity(directory: string): {
  readonly entries: readonly ManifestEntry[];
  readonly entry_count: number;
  readonly total_bytes: number;
  readonly digest: string;
} {
  const root = assertIsolatedRoot(directory);
  if (!lstatSync(root).isDirectory()) throw new PersonalOsError("E_STAGE_INVALID");
  const entries: ManifestEntry[] = [];
  walk(root, root, entries, false);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    entries,
    entry_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    digest: createHash("sha256").update("orca-jarvis/runtime-dependencies/v1\0")
      .update(canonicalize(entries)).digest("hex"),
  };
}

export function buildReleaseManifest(input: ManifestInput): ReleaseManifest {
  const root = assertIsolatedRoot(input.root);
  const entries: ManifestEntry[] = [];
  walk(root, root, entries, true);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const total_bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const payload_digest = createHash("sha256").update(PAYLOAD_DOMAIN).update(canonicalize(entries)).digest("hex");
  return {
    schema_version: 1,
    artifact: input.artifact,
    source: input.source,
    build: input.build,
    entries,
    entry_count: entries.length,
    total_bytes,
    payload_digest,
    self_exclusion: { path: MANIFEST_NAME, count: 1 },
  };
}

export function writeReleaseManifest(input: ManifestInput & { readonly sidecarDir: string }): {
  readonly manifest: ReleaseManifest;
  readonly sidecarPath: string;
} {
  const manifest = buildReleaseManifest(input);
  const bytes = `${canonicalize(manifest)}\n`;
  writeFileSync(join(input.root, MANIFEST_NAME), bytes);
  const sidecarDir = assertIsolatedRoot(input.sidecarDir);
  mkdirSync(sidecarDir, { recursive: true });
  const sidecarPath = join(sidecarDir, `${input.source.commit}.manifest.sidecar.json`);
  const sidecar = `${canonicalize({
    schema_version: 1,
    manifest_path: MANIFEST_NAME,
    manifest_sha256: createHash("sha256").update(bytes).digest("hex"),
    payload_digest: manifest.payload_digest,
  })}\n`;
  writeFileSync(sidecarPath, sidecar);
  return { manifest, sidecarPath };
}
