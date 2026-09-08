import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { observeBackendFiles } from "./backend-build-files.js";
import { parseBackendBuildRecord, type BackendBuildRecord } from "./backend-build-record.js";
import { databaseIdentity } from "./runtime-database-identity.js";
import type { RuntimeIdentityReport } from "./runtime-identity-contracts.js";

export type { RuntimeIdentityReport } from "./runtime-identity-contracts.js";
export type RuntimeIdentityReader = (now: Date) => RuntimeIdentityReport;

// This root follows the loaded module, not cwd or the operator's current checkout.
const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export function createRuntimeIdentityReader(db: Database.Database | (() => Database.Database), root = moduleRoot): RuntimeIdentityReader {
  const processIdentity = { pid: process.pid, started_at: new Date(performance.timeOrigin).toISOString(),
    node: process.version, modules: process.versions.modules, platform: process.platform, arch: process.arch };
  const capture = captureBuild(root);
  return now => ({ schema_version: 1, process: { ...processIdentity }, build: { ...capture.build },
    database: databaseIdentity(typeof db === "function" ? db() : db, capture.expected?.migrations ?? null, now) });
}

function captureBuild(root: string): {
  readonly build: RuntimeIdentityReport["build"]; readonly expected: BackendBuildRecord | null;
} {
  const empty: RuntimeIdentityReport["build"] = { status: "missing", checked_at: new Date().toISOString(),
    source_head: null, source_dirty: null, input_digest: null, artifact_digest: null,
    observed_artifact_digest: null, artifact_files: null, migration_digest: null, migration_count: null, toolchain_status: "unknown" };
  let bytes: Buffer;
  try {
    const path = join(root, "build-metadata.json");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { build: { ...empty, status: "invalid" }, expected: null };
    bytes = readFileSync(path);
    if (bytes.length > 10 * 1024 * 1024) return { build: { ...empty, status: "invalid" }, expected: null };
  } catch (error) {
    return { build: { ...empty, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }, expected: null };
  }
  let expected: BackendBuildRecord;
  try { expected = parseBackendBuildRecord(JSON.parse(bytes.toString("utf8"))); }
  catch { return { build: { ...empty, status: "invalid" }, expected: null }; }
  const { source, artifact } = expected;
  const toolchain = source.toolchain;
  const build: RuntimeIdentityReport["build"] = { ...empty, source_head: source.head, source_dirty: source.dirty,
    input_digest: source.input_digest, artifact_digest: artifact.digest, artifact_files: artifact.file_count,
    migration_digest: expected.migration_digest, migration_count: expected.migrations.length,
    toolchain_status: toolchain.node === process.version && toolchain.modules === process.versions.modules
      && toolchain.platform === process.platform && toolchain.arch === process.arch ? "matched" : "mismatch" };
  try {
    const actual = observeBackendFiles(root);
    return { build: { ...build, observed_artifact_digest: actual.digest,
      status: actual.digest === artifact.digest ? "matched" : "mismatch" }, expected };
  } catch { return { build: { ...build, status: "unreadable" }, expected }; }
}
