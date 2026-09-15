import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { execute } from "../../src/cli-runtime.mjs";
import {
  MIGRATION_VECTOR_CANONICAL_REF,
  migrationVectorDigest,
} from "../../src/personal-os-compatibility.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const CURRENT_SHA = "1".repeat(40);
const TARGET_SHA = "2".repeat(40);
const PROVIDER_SHA = "3".repeat(40);
/**
 * A path assertIsolatedRoot treats as protected because it is inside PROTECTED_ROOTS[0], and which
 * exists nowhere: every assertion here refuses before reading, so no deployed state is touched.
 */
const PROTECTED_FIXTURE_ROOT = "/home/jm/.local/state/orca-jarvis/absent-rollback-fixture-root";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ManifestOptions = { readonly commit: string; readonly tree: string; readonly payloadDigest: string };

function writeManifest(directory: string, options: ManifestOptions): string {
  mkdirSync(directory, { recursive: true });
  const body = `${canonicalize({
    schema_version: 1,
    artifact: "jarvis-authority",
    source: {
      commit: options.commit, tree: options.tree, first_parent: "0".repeat(40),
      subject: "fixture release", commit_timestamp: "2026-09-15T00:00:00+09:00",
      archive_digest: sha256(options.commit),
    },
    payload_digest: options.payloadDigest,
  })}\n`;
  writeFileSync(join(directory, "release.manifest.json"), body);
  return sha256(body);
}

/** An isolated release root with a published current release, a rollback target and a provider. */
async function releaseRoot(overrides: {
  readonly acceptedDigests?: readonly string[];
  readonly providerContractDigest?: string;
  readonly targetManifestSha?: string;
  readonly omitReceipt?: boolean;
} = {}): Promise<{ readonly root: string; readonly dbPath: string; readonly vector: string }> {
  const root = mkdtempSync(join(tmpdir(), "release-rollback-"));
  roots.push(root);
  const db = await migratedTestDatabase(tempDb());
  const dbPath = db.filename;
  const migrations = db.db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: string; sha256: string }>;
  db.close();
  const vector = migrationVectorDigest({
    canonical_ref: MIGRATION_VECTOR_CANONICAL_REF, head: HEAD, tree: TREE, migrations,
  });

  // The running release; its own source identity is not what the vector is bound to.
  writeManifest(join(root, "releases", CURRENT_SHA),
    { commit: "c".repeat(40), tree: "d".repeat(40), payloadDigest: sha256("current") });
  symlinkSync(`releases/${CURRENT_SHA}`, join(root, "current"));

  // The rollback target seals the source identity the expected vector is computed from.
  const targetPayload = sha256("target-payload");
  const targetDir = join(root, "releases", TARGET_SHA);
  const manifestSha = writeManifest(targetDir, { commit: HEAD, tree: TREE, payloadDigest: targetPayload });
  writeFileSync(join(targetDir, "release-compatibility.json"), `${canonicalize({
    schema_version: 1,
    accepted_vector_digests: overrides.acceptedDigests ?? [vector],
  })}\n`);

  const providerPayload = sha256("provider-payload");
  writeManifest(join(root, "provider-releases", PROVIDER_SHA), {
    commit: PROVIDER_SHA, tree: PROVIDER_SHA, payloadDigest: providerPayload,
  });
  symlinkSync(PROVIDER_SHA, join(root, "provider-releases", "current"));

  if (overrides.omitReceipt !== true) {
    mkdirSync(join(root, "receipts"), { recursive: true });
    writeFileSync(join(root, "receipts", `${TARGET_SHA}.json`), `${canonicalize({
      schema_version: 1,
      release: TARGET_SHA,
      payload_digest: targetPayload,
      manifest_sha256: overrides.targetManifestSha ?? manifestSha,
      provider_contract_digest: overrides.providerContractDigest ?? providerPayload,
    })}\n`);
  }
  return { root, dbPath, vector };
}

const current = (root: string): string => readlinkSync(join(root, "current"));

/**
 * A rollback target as it looks before sealed manifests: the migrations it ships, and neither a
 * release-compatibility.json nor a receipt to qualify it with.
 */
function unqualifiedTarget(root: string, sha: string, migrations: readonly string[]): string {
  const directory = join(root, "releases", sha);
  mkdirSync(join(directory, "migrations"), { recursive: true });
  for (const name of migrations) {
    copyFileSync(join("migrations", name), join(directory, "migrations", name));
  }
  rmSync(join(directory, "release-compatibility.json"), { force: true });
  rmSync(join(root, "receipts", `${sha}.json`), { force: true });
  return directory;
}

function shippedMigrationNames(): readonly string[] {
  return readdirSync("migrations").filter(name => name.endsWith(".sql")).sort();
}

/** A backup taken from a fully migrated database: its own applied vector is the shipped vector. */
async function fixtureBackup(): Promise<string> {
  const db = await migratedTestDatabase(tempDb());
  const source = db.filename;
  db.close();
  const path = `${source}.backup`;
  copyFileSync(source, path);
  return path;
}

describe("release rollback", () => {
  it("allows a rollback whose vector, provider contract and sealed manifest all match", async () => {
    const fixture = await releaseRoot();
    const result = await execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath]);
    expect(result).toMatchObject({
      ok: true, command: "release.rollback", rollback: "allow", dry_run: false,
      current_target: `releases/${TARGET_SHA}`,
      facts: { current_release: CURRENT_SHA, target_release: TARGET_SHA,
        expected_vector_digest: fixture.vector, provider_contract_match: true, sealed_manifest_match: true },
    });
    expect(current(fixture.root)).toBe(`releases/${TARGET_SHA}`);
  });

  it("leaves current unchanged for a dry run", async () => {
    const fixture = await releaseRoot();
    const result = await execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--dry-run"]);
    expect(result).toMatchObject({ rollback: "allow", dry_run: true, current_target: `releases/${CURRENT_SHA}` });
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
  });

  it("refuses with RELEASE_ROLLBACK_INCOMPATIBLE and leaves current unchanged", async () => {
    for (const overrides of [
      { acceptedDigests: ["f".repeat(64)] },
      { providerContractDigest: "e".repeat(64) },
      { targetManifestSha: "d".repeat(64) },
      { omitReceipt: true },
    ]) {
      const fixture = await releaseRoot(overrides);
      await expect(execute(["release", "rollback", "--to", TARGET_SHA,
        "--release-root", fixture.root, "--db", fixture.dbPath]))
        .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
      expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
    }
  });

  it("refuses an unpublished target, a malformed target and missing inputs", async () => {
    const fixture = await releaseRoot();
    await expect(execute(["release", "rollback", "--to", "9".repeat(40),
      "--release-root", fixture.root, "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
    await expect(execute(["release", "rollback", "--to", "not-a-sha",
      "--release-root", fixture.root, "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INPUT_INVALID" });
    await expect(execute(["release", "rollback", "--release-root", fixture.root, "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INPUT_INVALID" });
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
  });

  it("refuses a protected release root instead of touching a deployed one", async () => {
    const fixture = await releaseRoot();
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", PROTECTED_FIXTURE_ROOT, "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
  });

  it("reaches a protected root only with --production-root and the owner gate", async () => {
    const fixture = await releaseRoot();
    delete process.env["JARVIS_PRODUCTION_ACTIVATION_APPROVAL"];
    // The flag alone is not the evidence; the refusal is decided before anything is read.
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", PROTECTED_FIXTURE_ROOT, "--db", fixture.dbPath, "--production-root"]))
      .rejects.toMatchObject({ code: "JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED" });
    // And the evidence alone is not the request: the flag is what names the protected root.
    process.env["JARVIS_PRODUCTION_ACTIVATION_APPROVAL"] = "approved";
    try {
      await expect(execute(["release", "rollback", "--to", TARGET_SHA,
        "--release-root", PROTECTED_FIXTURE_ROOT, "--db", fixture.dbPath]))
        .rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
      // With both, the root is read like any other and the same three checks decide.
      const allowed = await execute(["release", "rollback", "--to", TARGET_SHA,
        "--release-root", fixture.root, "--db", fixture.dbPath, "--production-root", "--dry-run"]);
      expect(allowed).toMatchObject({ ok: true, rollback: "allow", dry_run: true });
    } finally {
      delete process.env["JARVIS_PRODUCTION_ACTIVATION_APPROVAL"];
    }
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
  });
});

describe("release rollback --restore-backup", () => {
  it("restores the backup and switches current when the backup is on the target's vector", async () => {
    const fixture = await releaseRoot();
    unqualifiedTarget(fixture.root, TARGET_SHA, shippedMigrationNames());
    const backup = await fixtureBackup();
    const backupBytes = readFileSync(backup);

    // The three qualification checks cannot pass for this target, so the ordinary form refuses.
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INCOMPATIBLE" });

    const preview = await execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", backup, "--dry-run"]);
    expect(preview).toMatchObject({
      ok: true, command: "release.rollback", rollback: "restore", dry_run: true,
      target_release: TARGET_SHA, current_target: `releases/${CURRENT_SHA}`,
      backup: { path: backup, quick_check: "ok" },
      database: { path: fixture.dbPath, restored: false, replaced: null },
    });
    const facts = preview as unknown as { target_vector: { digest: string; migrations: number; source: string };
      backup: { vector_digest: string; applied_migrations: number }; systemd_order: string[] };
    expect(facts.target_vector.digest).toBe(facts.backup.vector_digest);
    expect(facts.target_vector).toMatchObject({ source: "migrations",
      migrations: shippedMigrationNames().length });
    expect(facts.backup.applied_migrations).toBe(shippedMigrationNames().length);
    // It stops nothing itself; it prints the order the operator performs around it.
    expect(facts.systemd_order[0]).toBe("systemctl --user stop jm-jarvis-dashboard.service");
    expect(facts.systemd_order).toContain("systemctl --user start jm-jarvis.service");
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);

    const restored = await execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", backup]);
    expect(restored).toMatchObject({ rollback: "restore", dry_run: false,
      current_target: `releases/${TARGET_SHA}`, database: { restored: true } });
    expect(current(fixture.root)).toBe(`releases/${TARGET_SHA}`);
    // The database is the backup's bytes, and the database it replaced is kept beside it.
    expect(readFileSync(fixture.dbPath)).toEqual(backupBytes);
    const replaced = (restored as unknown as { database: { replaced: string } }).database.replaced;
    expect(replaced.startsWith(`${fixture.dbPath}.replaced-`)).toBe(true);
    expect(existsSync(replaced)).toBe(true);
    expect(existsSync(`${fixture.dbPath}-wal`)).toBe(false);
    expect(readdirSync(join(replaced, "..")).filter(name => name.includes(".restore-"))).toEqual([]);
  }, 60_000);

  it("refuses a backup whose vector is not the target's, and an unusable backup", async () => {
    const fixture = await releaseRoot();
    const names = shippedMigrationNames();
    unqualifiedTarget(fixture.root, TARGET_SHA, names.slice(0, names.length - 1));
    const backup = await fixtureBackup();
    const before = readFileSync(fixture.dbPath);
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", backup]))
      .rejects.toMatchObject({ code: "RELEASE_RESTORE_VECTOR_MISMATCH" });
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
    expect(readFileSync(fixture.dbPath)).toEqual(before);

    const notADatabase = `${backup}.text`;
    writeFileSync(notADatabase, "not a database\n");
    unqualifiedTarget(fixture.root, TARGET_SHA, names);
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", notADatabase]))
      .rejects.toMatchObject({ code: "RELEASE_RESTORE_BACKUP_UNUSABLE" });
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", `${backup}.absent`]))
      .rejects.toMatchObject({ code: "RELEASE_RESTORE_BACKUP_UNAVAILABLE" });
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
    expect(readFileSync(fixture.dbPath)).toEqual(before);
  }, 60_000);

  it("refuses a target that ships no migrations, an absent target and a protected root", async () => {
    const fixture = await releaseRoot();
    const backup = await fixtureBackup();
    // The published fixture target carries a manifest and no migrations at all.
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", backup]))
      .rejects.toMatchObject({ code: "RELEASE_RESTORE_TARGET_VECTOR_UNAVAILABLE" });
    await expect(execute(["release", "rollback", "--to", "9".repeat(40),
      "--release-root", fixture.root, "--db", fixture.dbPath, "--restore-backup", backup]))
      .rejects.toMatchObject({ code: "RELEASE_RESTORE_TARGET_UNAVAILABLE" });
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", PROTECTED_FIXTURE_ROOT, "--db", fixture.dbPath, "--restore-backup", backup]))
      .rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
    await expect(execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", PROTECTED_FIXTURE_ROOT, "--db", fixture.dbPath,
      "--restore-backup", backup, "--production-root"]))
      .rejects.toMatchObject({ code: "JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED" });
    expect(current(fixture.root)).toBe(`releases/${CURRENT_SHA}`);
  }, 60_000);
});
