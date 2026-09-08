import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { fileIdentity, buildDigest, BACKEND_OUTPUT_ROOTS } from "../../scripts/lib/backend-build-identity.mjs";
import { createRuntimeIdentityReader } from "../../src/runtime-identity.js";

const cleanup = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const now = new Date("2026-09-08T03:00:00.000Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-runtime-identity-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "src/index.js"), "export const value = 42;\n");
  writeFileSync(join(root, "migrations/001_test.sql"), "CREATE TABLE records(value TEXT);\n");
  const artifact = fileIdentity(root, BACKEND_OUTPUT_ROOTS);
  const migrations = artifact.entries.filter(e => e.path.startsWith("migrations/"))
    .map(e => ({ id: e.path.slice(11), checksum: e.sha256.slice(7) }));
  const record = { schema_version: 1, kind: "jarvis-backend-build",
    source: { head: "a".repeat(40), dirty: true, input_digest: buildDigest("input"), input_file_count: 2,
      toolchain: { node: process.version, modules: process.versions.modules, platform: process.platform,
        arch: process.arch, typescript: "5.9.2" } },
    artifact, migrations, migration_digest: buildDigest(`orca-jarvis/migration-vector/v1\0${JSON.stringify(migrations)}`) };
  const save = () => writeFileSync(join(root, "build-metadata.json"), JSON.stringify(record)); save();
  const db = new Database(join(root, "db.sqlite")); cleanup.push(() => { if (db.open) db.close(); });
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL); CREATE TABLE records(value TEXT)");
  db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migrations[0].id, migrations[0].checksum);
  return { root, db, record, save };
}
const changes = db => db.prepare("SELECT total_changes() AS count").get().count;

describe("backend runtime identity", () => {
  it("consumes producer vectors and reports DB records without writing or leaking file paths", () => {
    const { root, db, record } = fixture(); const before = changes(db);
    const report = createRuntimeIdentityReader(db, root)(now);
    expect(report.build).toMatchObject({ status: "matched", source_head: record.source.head, source_dirty: true,
      artifact_digest: record.artifact.digest, observed_artifact_digest: record.artifact.digest, toolchain_status: "matched" });
    expect(report.database).toMatchObject({ status: "matched", applied_migrations: 1, missing: 0, unexpected: 0, changed: 0 });
    expect(report.database.schema_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toContain(root); expect(JSON.stringify(report)).not.toContain("index.js");
    expect(changes(db)).toBe(before);
  });
  it("keeps startup observation fixed after disk mutation while a new reader detects the changed file", () => {
    const { root, db } = fixture(); const read = createRuntimeIdentityReader(db, root); const first = read(now);
    writeFileSync(join(root, "src/index.js"), "export const value = 43;\n");
    expect(read(now).build).toEqual(first.build);
    const next = createRuntimeIdentityReader(db, root)(now);
    expect(next.build.status).toBe("mismatch"); expect(next.build.observed_artifact_digest).not.toBe(first.build.artifact_digest);
    first.build.source_head = "caller mutation";
    expect(read(now).build.source_head).toBe("a".repeat(40));
  });
  it("does not infer a source commit or expected DB from a missing build record", () => {
    const { root, db } = fixture(); rmSync(join(root, "build-metadata.json"));
    const report = createRuntimeIdentityReader(db, root)(now);
    expect(report.build).toMatchObject({ status: "missing", source_head: null, source_dirty: null });
    expect(report.database).toMatchObject({ status: "unverified", applied_migrations: 1, missing: null });
  });
  it.each(["version", "digest", "count", "migration", "duplicate", "traversal"])("rejects invalid %s records", kind => {
    const { root, db, record, save } = fixture();
    if (kind === "version") record.schema_version = 2;
    if (kind === "digest") record.artifact.digest = buildDigest("wrong");
    if (kind === "count") record.artifact.file_count += 1;
    if (kind === "migration") record.migrations[0].checksum = "b".repeat(64);
    if (kind === "duplicate") record.artifact.entries.push(record.artifact.entries[0]);
    if (kind === "traversal") record.artifact.entries[0].path = "../PRIVATE_MARKER";
    save(); const report = createRuntimeIdentityReader(db, root)(now);
    expect(report.build.status).toBe("invalid"); expect(report.database.status).toBe("unverified");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_MARKER");
  });
  it("rejects malformed JSON and symlink manifests without exposing raw contents", () => {
    const { root, db } = fixture(); const path = join(root, "build-metadata.json");
    writeFileSync(path, "PRIVATE_MARKER"); expect(createRuntimeIdentityReader(db, root)(now).build.status).toBe("invalid");
    rmSync(path); symlinkSync(join(root, "src/index.js"), path);
    expect(createRuntimeIdentityReader(db, root)(now).build.status).toBe("invalid");
  });
  it("separates runtime toolchain mismatch from identical artifact bytes", () => {
    const { root, db, record, save } = fixture(); record.source.toolchain.modules = "99999"; save();
    expect(createRuntimeIdentityReader(db, root)(now).build).toMatchObject({ status: "matched", toolchain_status: "mismatch" });
  });
  it("detects missing, extra and altered migration records using the current DB snapshot", () => {
    const { root, db } = fixture(); const read = createRuntimeIdentityReader(db, root);
    db.prepare("UPDATE schema_migrations SET checksum=?").run("b".repeat(64));
    expect(read(now).database).toMatchObject({ status: "mismatch", missing: 0, unexpected: 0, changed: 1 });
    db.exec("DELETE FROM schema_migrations");
    db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run("999_extra.sql", "c".repeat(64));
    expect(read(now).database).toMatchObject({ status: "mismatch", missing: 1, unexpected: 1, changed: 0 });
  });
  it("reports actual schema changes separately from matching migration records", () => {
    const { root, db } = fixture(); const read = createRuntimeIdentityReader(db, root); const first = read(now).database;
    db.exec("ALTER TABLE records ADD COLUMN unexpected TEXT");
    const second = read(now).database;
    expect(second.status).toBe("matched"); expect(second.schema_digest).not.toBe(first.schema_digest);
    db.exec("DROP TABLE schema_migrations");
    expect(read(now).database).toMatchObject({ status: "unavailable", applied_migrations: null, schema_digest: expect.any(String) });
  });
  it("does not report matching records when a rebuilt journal contains duplicate migration IDs", () => {
    const { root, db } = fixture(); const read = createRuntimeIdentityReader(db, root);
    db.exec("CREATE TABLE duplicate_journal AS SELECT * FROM schema_migrations; DROP TABLE schema_migrations; "
      + "ALTER TABLE duplicate_journal RENAME TO schema_migrations; INSERT INTO schema_migrations SELECT * FROM schema_migrations");
    expect(read(now).database.status).toBe("unavailable");
  });
  it("reads a reopened DB handle while retaining startup identity and handles invalid clock", () => {
    const { root, db } = fixture(); let current = db;
    const read = createRuntimeIdentityReader(() => current, root); const first = read(now);
    db.close(); expect(read(now).database.status).toBe("unavailable");
    current = new Database(join(root, "db.sqlite")); cleanup.push(() => current.close());
    expect(read(now).build).toEqual(first.build); expect(read(now).database).toEqual(first.database);
    expect(read(new Date(NaN)).database.observed_at).toBeNull();
  });
  it("rejects unreadable artifact directories and changed file mode", () => {
    const { root, db } = fixture(); const bytes = readFileSync(join(root, "src/index.js"));
    rmSync(join(root, "src/index.js")); symlinkSync(join(root, "migrations/001_test.sql"), join(root, "src/index.js"));
    expect(createRuntimeIdentityReader(db, root)(now).build.status).toBe("unreadable");
    rmSync(join(root, "src/index.js")); writeFileSync(join(root, "src/index.js"), bytes, { mode: 0o700 });
    expect(createRuntimeIdentityReader(db, root)(now).build.status).toBe("mismatch");
  });
});
