import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  writeManifest(join(root, "releases", CURRENT_SHA), { commit: HEAD, tree: TREE, payloadDigest: sha256("current") });
  symlinkSync(`releases/${CURRENT_SHA}`, join(root, "current"));

  const targetPayload = sha256("target-payload");
  const targetDir = join(root, "releases", TARGET_SHA);
  const manifestSha = writeManifest(targetDir, {
    commit: "c".repeat(40), tree: "d".repeat(40), payloadDigest: targetPayload,
  });
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

describe("release rollback", () => {
  it("allows a rollback whose vector, provider contract and sealed manifest all match", async () => {
    const fixture = await releaseRoot();
    const result = await execute(["release", "rollback", "--to", TARGET_SHA,
      "--release-root", fixture.root, "--db", fixture.dbPath]);
    expect(result).toMatchObject({
      ok: true, command: "release.rollback", rollback: "allow", dry_run: false,
      current_target: `releases/${TARGET_SHA}`,
      facts: { current_release: CURRENT_SHA, target_release: TARGET_SHA,
        current_vector_digest: fixture.vector, provider_contract_match: true, sealed_manifest_match: true },
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
      "--release-root", "/home/jm/.local/state/orca-jarvis/authority", "--db", fixture.dbPath]))
      .rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
  });
});
