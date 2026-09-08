import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { BACKEND_OUTPUT_ROOTS, backendSourceIdentity, buildDigest, fileIdentity } from "./lib/backend-build-identity.mjs";

const root = process.cwd();
const output = resolve(root, "dist");
const metadata = join(output, "build-metadata.json");
mkdirSync(output, { recursive: true });
// SQLite's OS lock is released on process death; there is no stale PID-file recovery race.
const lock = new Database(join(output, ".backend-build-lock.sqlite"), { timeout: 0 });
try { lock.exec("BEGIN EXCLUSIVE"); }
catch { lock.close(); process.stderr.write("BACKEND_BUILD_ACTIVE\n"); process.exit(1); }
// A failed/interrupted build must not advertise a previous successful manifest.
rmSync(metadata, { force: true });
const staging = mkdtempSync(join(output, ".backend-stage-"));
const compiled = join(staging, "compiled");
const prior = join(staging, "prior");
let publishing = false;
let preserveStaging = false;
const moved = [];
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
  if (result.error || result.signal || result.status !== 0) throw new Error("BACKEND_BUILD_COMMAND_FAILED");
}
try {
  const source = backendSourceIdentity(root);
  run(join(root, "node_modules/typescript/bin/tsc"), ["--outDir", compiled]);
  run(join(root, "scripts/copy-migrations.mjs"), [compiled]);
  if (JSON.stringify(source) !== JSON.stringify(backendSourceIdentity(root))) throw new Error("BACKEND_BUILD_SOURCE_CHANGED");
  if (readdirSync(compiled).some(name => !BACKEND_OUTPUT_ROOTS.includes(name))) throw new Error("BACKEND_BUILD_OUTPUT_UNEXPECTED");
  const artifact = fileIdentity(compiled, BACKEND_OUTPUT_ROOTS);
  const migrations = artifact.entries.filter(entry => entry.path.startsWith("migrations/") && entry.path.endsWith(".sql"))
    .map(entry => ({ id: entry.path.slice("migrations/".length), checksum: entry.sha256.slice("sha256:".length) }));
  const manifest = { schema_version: 1, kind: "jarvis-backend-build", source,
    artifact, migrations, migration_digest: buildDigest(`orca-jarvis/migration-vector/v1\0${JSON.stringify(migrations)}`) };
  mkdirSync(prior);
  publishing = true;
  for (const name of BACKEND_OUTPUT_ROOTS) {
    const saved = existsSync(join(output, name));
    if (saved) renameSync(join(output, name), join(prior, name));
    moved.push({ name, saved });
    if (existsSync(join(compiled, name))) renameSync(join(compiled, name), join(output, name));
  }
  if (fileIdentity(output, BACKEND_OUTPUT_ROOTS).digest !== artifact.digest) throw new Error("BACKEND_BUILD_PUBLICATION_CHANGED");
  const pending = join(staging, "build-metadata.json");
  writeFileSync(pending, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  renameSync(pending, metadata);
  publishing = false;
  process.stdout.write(`${JSON.stringify({ event: "backend_build_recorded", source_head: source.head,
    source_dirty: source.dirty, input_digest: source.input_digest, artifact_digest: artifact.digest,
    artifact_files: artifact.file_count, migration_count: migrations.length })}\n`);
} catch (error) {
  try { rmSync(metadata, { force: true }); }
  catch {
    preserveStaging = true;
    process.stderr.write(`BACKEND_BUILD_METADATA_CLEANUP_FAILED ${JSON.stringify({ recovery_root: staging })}\n`);
  }
  if (publishing) for (const { name, saved } of moved.reverse()) {
    try {
      rmSync(join(output, name), { recursive: true, force: true });
      if (saved) renameSync(join(prior, name), join(output, name));
    } catch {
      preserveStaging = true;
      process.stderr.write(`BACKEND_BUILD_ROLLBACK_FAILED ${JSON.stringify({ recovery_root: staging })}\n`);
    }
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  try { if (!preserveStaging) rmSync(staging, { recursive: true, force: true }); }
  finally { try { lock.exec("ROLLBACK"); } finally { lock.close(); } }
}
