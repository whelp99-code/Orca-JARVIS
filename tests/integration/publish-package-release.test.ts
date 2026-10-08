import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execute } from "../../src/cli-runtime.mjs";
import { AuthorityDb } from "../../src/db.js";
import { ensureCycleCursor } from "../../src/personal-os-cycle-channel.js";
import { runtimeDependencyIdentity } from "../../src/personal-os-release-manifest.js";
import { writeSecondBrainFixtureLauncher } from "../fixtures/second-brain-transport-harness.js";
import { tempDb } from "../helpers.js";

const SCRIPT = "ops/authority/publish-package-release.sh";
/** Only what the published CLI actually loads, so the fixture package stays small. */
const RUNTIME_DEPENDENCIES = ["better-sqlite3", "zod", "bindings", "file-uri-to-path", "@modelcontextprotocol"];

const roots: string[] = [];
const children: ChildProcess[] = [];
let shared: FixturePackage;
let dashboardUrl: string;
let provider: { readonly launcher: string; readonly config: string };

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

type PackageOverride = {
  /** Rewrite the recorded source identity so a second, distinct release can be published. */
  readonly head?: string;
  readonly tree?: string;
  /** Drop the committed provenance, as a package built without a checkout would. */
  readonly withoutProvenance?: boolean;
};

type FixturePackage = {
  readonly root: string;
  readonly pin: string;
  readonly sourceHead: string;
  readonly sourceTree: string;
};

/** A verifiable runtime package built from this checkout; nothing outside it is referenced. */
async function fixturePackage(override: PackageOverride = {}): Promise<FixturePackage> {
  const identity = await import(pathToFileURL(resolve("scripts/lib/backend-build-identity.mjs")).href);
  const { RUNTIME_PACKAGE_ROOTS } = await import(pathToFileURL(resolve("scripts/lib/runtime-package-roots.mjs")).href);
  const root = scratch("publish-package-");
  for (const name of RUNTIME_PACKAGE_ROOTS as readonly string[]) {
    mkdirSync(join(root, dirname(name)), { recursive: true });
    execFileSync("cp", ["-a", "--", name, join(root, name)]);
  }
  mkdirSync(join(root, "node_modules"), { recursive: true });
  for (const name of RUNTIME_DEPENDENCIES) {
    if (existsSync(join("node_modules", name))) {
    execFileSync("cp", ["-a", "--", join("node_modules", name), join(root, "node_modules", name)]);
    }
  }
  const metadataPath = join(root, "dist/build-metadata.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const provenance = identity.releaseSourceIdentity(resolve("."));
  if (provenance === null) throw new Error("fixture requires a checkout that can answer for HEAD");
  const head = override.head ?? metadata.source.head;
  const tree = override.tree ?? metadata.source.tree;
  if (override.head !== undefined || override.tree !== undefined) {
    metadata.source = { ...metadata.source, head, tree };
    writeFileSync(metadataPath, JSON.stringify(metadata));
  }
  const receipt = JSON.stringify({
    schema_version: 1,
    kind: "isolated-authority-runtime-package",
    source: metadata.source,
    ...(override.withoutProvenance === true
      ? {}
      : { release_source: { ...provenance, commit: head, tree } }),
    payload: identity.fileIdentity(root, RUNTIME_PACKAGE_ROOTS),
    dependencies: runtimeDependencyIdentity(join(root, "node_modules")),
    deployment_ready: false,
  });
  writeFileSync(join(root, "runtime-package-receipt.json"), receipt);
  return { root, pin: createHash("sha256").update(receipt).digest("hex"), sourceHead: head, sourceTree: tree };
}

/**
 * A published provider release in the same root. The rollback rule compares the provider contract a
 * release was sealed against with the one published here, so there has to be one.
 */
function publishFixtureProvider(releaseRoot: string): string {
  const sha = "7".repeat(40);
  const directory = join(releaseRoot, "provider-releases", sha);
  mkdirSync(directory, { recursive: true });
  const payloadDigest = createHash("sha256").update(`provider:${sha}`).digest("hex");
  writeFileSync(join(directory, "release.manifest.json"), `${JSON.stringify({
    schema_version: 1, artifact: "second-brain-provider", payload_digest: payloadDigest,
  })}\n`);
  symlinkSync(sha, join(releaseRoot, "provider-releases", "current"));
  return payloadDigest;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(res => probe.listen(0, "127.0.0.1", () => res()));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("health fixture unavailable");
  const { port } = address;
  await new Promise<void>(res => probe.close(() => res()));
  return port;
}

/**
 * The health route must answer while the publish script runs, and spawnSync blocks this process,
 * so the fixture dashboard lives in its own process.
 */
async function healthServer(): Promise<string> {
  const port = await freePort();
  const root = scratch("publish-health-");
  const script = join(root, "health.mjs");
  writeFileSync(script, 'import { createServer } from "node:http";\n'
    + 'createServer((_q, r) => { r.writeHead(200, { "content-type": "application/json" });\n'
    + '  r.end(JSON.stringify({ schema_version: 1, status: "ok", authority: "ready" })); })\n'
    + `  .listen(${port}, "127.0.0.1");\n`);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  children.push(child);
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) { await response.text(); return url; }
    } catch { /* the fixture server is still starting */ }
    await new Promise<void>(res => { setTimeout(res, 50); });
  }
  throw new Error("health fixture never answered");
}

/** The fixture stdio provider the transport suites already use, in an isolated installation. */
function fixtureProvider(): { launcher: string; config: string } {
  const root = scratch("publish-provider-");
  const target = resolve("tests/fixtures/second-brain-mcp-child.mjs");
  const launcher = join(root, "second-brain-mcp");
  const control = join(root, "control");
  const receipt = join(root, "receipt");
  closeSync(openSync(control, "w"));
  closeSync(openSync(receipt, "w"));
  writeSecondBrainFixtureLauncher(launcher, target);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ control, receipt }));
  return { launcher, config };
}

async function gateableDatabase(): Promise<string> {
  const db = new AuthorityDb(tempDb());
  try {
    await db.migrate();
    ensureCycleCursor(db.db);
  } finally {
    db.close();
  }
  return db.filename;
}

function publish(args: readonly string[], env: Readonly<Record<string, string>> = {}) {
  const inherited = { ...process.env } as Record<string, string>;
  delete inherited["JARVIS_PRODUCTION_ACTIVATION_APPROVAL"];
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 300_000,
    env: {
      ...inherited,
      JARVIS_SECOND_BRAIN_LAUNCHER: provider.launcher,
      JARVIS_SECOND_BRAIN_CONFIG: provider.config,
      JARVIS_PUBLISH_STAGE_PARENT: scratch("publish-stage-"),
      ...env,
    },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function publishArgs(releaseRoot: string, dbPath: string): readonly string[] {
  return ["--package", shared.root, "--receipt-sha256", shared.pin,
    "--release-root", releaseRoot, "--db", dbPath, "--dashboard-url", dashboardUrl];
}

function payloadFiles(releaseDir: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  walk(releaseDir);
  return found;
}

beforeAll(async () => {
  shared = await fixturePackage();
  dashboardUrl = await healthServer();
  provider = fixtureProvider();
}, 600_000);

afterEach(() => {
  for (const root of roots.splice(3)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ops/authority/publish-package-release.sh", () => {
  it("leaves the old script untouched", () => {
    expect(readFileSync("ops/authority/publish-verified-release.sh", "utf8"))
      .toContain("npm run build");
    expect(readFileSync(SCRIPT, "utf8")).not.toContain("npm run build");
  });

  it("publishes the verified package, gates it, backs up, and does not activate", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const result = publish(publishArgs(releaseRoot, dbPath));
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const published = JSON.parse(result.stdout);
    expect(published).toMatchObject({ ok: true, release: shared.sourceHead, activated: false, current: "" });
    expect(existsSync(join(releaseRoot, "current"))).toBe(false);

    const receipt = JSON.parse(readFileSync(published.receipt, "utf8"));
    expect(receipt).toMatchObject({
      schema_version: 1, kind: "authority-package-release", release: shared.sourceHead,
      source_head: shared.sourceHead, package_receipt_sha256: shared.pin,
      payload_file_modes: [0o644], activated: false, activated_at: null,
      runtime_validation: "gates_only", deployment_ready: false,
    });
    expect(receipt.verification).toMatchObject({ ok: true, integrity: "matched", receipt_sha256: shared.pin });
    expect(receipt.gates.report).toMatchObject({ ok: true, failed: [] });
    expect(receipt.gates.report.gates).toHaveLength(9);
    expect(receipt.backup).toMatchObject({ ok: true, quick_check: "ok" });
    expect(existsSync(receipt.backup.destPath)).toBe(true);

    // Published files are 0644: the task verifier rejects mode & 0o022.
    const files = payloadFiles(published.release_path);
    expect(files.length).toBeGreaterThan(1_000);
    expect([...new Set(files.map(file => lstatSync(file).mode & 0o777))]).toEqual([0o644]);
    expect(lstatSync(published.receipt).mode & 0o022).toBe(0);
    for (const directory of [releaseRoot, join(releaseRoot, "releases"), join(releaseRoot, "receipts")]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    // The published payload is the package's bytes, not a rebuild.
    expect(readFileSync(join(published.release_path, "dist/src/cli.js")))
      .toEqual(readFileSync(join(shared.root, "dist/src/cli.js")));
  }, 600_000);

  it("refuses to activate without the owner production-activation-gate evidence", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const result = publish([...publishArgs(releaseRoot, dbPath), "--activate"]);
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe("JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED");
    // The refusal happens before anything is published.
    expect(readdirSync(releaseRoot)).toEqual([]);
  }, 600_000);

  it("switches the relative current symlink only with --activate and the owner gate", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const result = publish([...publishArgs(releaseRoot, dbPath), "--activate"],
      { JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved" });
    expect(result.code).toBe(0);
    const published = JSON.parse(result.stdout);
    expect(published).toMatchObject({ activated: true, current: `releases/${shared.sourceHead}` });
    expect(readlinkSync(join(releaseRoot, "current"))).toBe(`releases/${shared.sourceHead}`);
    expect(JSON.parse(readFileSync(published.receipt, "utf8")))
      .toMatchObject({ activated: true, activated_at: expect.any(String) });
    expect(readdirSync(releaseRoot).filter(name => name.startsWith(".current-"))).toEqual([]);
  }, 600_000);

  it("refuses a pin the candidate does not match, and publishes nothing", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const result = publish(["--package", shared.root, "--receipt-sha256", "f".repeat(64),
      "--release-root", releaseRoot, "--db", dbPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PACKAGE_RELEASE_VERIFICATION_FAILED");
    expect(existsSync(join(releaseRoot, "releases", shared.sourceHead))).toBe(false);
  }, 600_000);

  it("refuses to publish over an existing release and refuses bad usage", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    expect(publish(publishArgs(releaseRoot, dbPath)).code).toBe(0);
    const again = publish(publishArgs(releaseRoot, dbPath));
    expect(again.code).toBe(1);
    expect(again.stderr.trim()).toBe("PACKAGE_RELEASE_ALREADY_PUBLISHED");

    expect(publish(["--package", shared.root]).code).toBe(2);
    expect(publish(["--package", shared.root, "--receipt-sha256", "nothex",
      "--release-root", releaseRoot, "--db", dbPath]).code).toBe(2);
    expect(publish([...publishArgs(releaseRoot, dbPath), "--unknown"]).code).toBe(2);
  }, 900_000);

  it("seals a manifest and compatibility file from the receipt-carried provenance", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const providerDigest = publishFixtureProvider(releaseRoot);
    const result = publish(publishArgs(releaseRoot, dbPath));
    expect(result.code).toBe(0);
    const published = JSON.parse(result.stdout);
    const manifest = JSON.parse(readFileSync(join(published.release_path, "release.manifest.json"), "utf8"));
    expect(manifest.source).toMatchObject({ commit: shared.sourceHead, tree: shared.sourceTree });
    expect(manifest.artifact).toBe("jarvis-authority");
    const compatibility = JSON.parse(
      readFileSync(join(published.release_path, "release-compatibility.json"), "utf8"));
    expect(compatibility.schema_version).toBe(1);
    expect(compatibility.accepted_vector_digests).toHaveLength(1);

    const receipt = JSON.parse(readFileSync(published.receipt, "utf8"));
    expect(receipt).toMatchObject({
      source_tree: shared.sourceTree,
      payload_digest: manifest.payload_digest,
      accepted_vector_digest: compatibility.accepted_vector_digests[0],
      provider_contract_digest: providerDigest,
    });
    expect(receipt.manifest_sha256).toBe(createHash("sha256")
      .update(readFileSync(join(published.release_path, "release.manifest.json"))).digest("hex"));
    for (const name of ["release.manifest.json", "release-compatibility.json"]) {
      expect(lstatSync(join(published.release_path, name)).mode & 0o777).toBe(0o644);
    }
  }, 600_000);

  it("publishes a release that release rollback accepts as a target", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    publishFixtureProvider(releaseRoot);
    expect(publish([...publishArgs(releaseRoot, dbPath), "--activate"],
      { JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved" }).code).toBe(0);

    const first = await execute(["release", "rollback", "--to", shared.sourceHead,
      "--release-root", releaseRoot, "--db", dbPath, "--dry-run"]);
    expect(first).toMatchObject({ ok: true, rollback: "allow", dry_run: true,
      facts: { target_release: shared.sourceHead, provider_contract_match: true, sealed_manifest_match: true } });

    // A second release is published and activated; the first stays a reachable rollback target.
    const second = await fixturePackage({ head: "5".repeat(40), tree: "6".repeat(40) });
    expect(publish(["--package", second.root, "--receipt-sha256", second.pin,
      "--release-root", releaseRoot, "--db", dbPath, "--dashboard-url", dashboardUrl, "--activate"],
      { JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved" }).code).toBe(0);
    expect(readlinkSync(join(releaseRoot, "current"))).toBe(`releases/${second.sourceHead}`);

    const back = await execute(["release", "rollback", "--to", shared.sourceHead,
      "--release-root", releaseRoot, "--db", dbPath]);
    expect(back).toMatchObject({ ok: true, rollback: "allow", dry_run: false,
      current_target: `releases/${shared.sourceHead}`,
      facts: { current_release: second.sourceHead, target_release: shared.sourceHead } });
    expect(readlinkSync(join(releaseRoot, "current"))).toBe(`releases/${shared.sourceHead}`);
  }, 900_000);

  it("refuses a rollback once the database schema has moved off the sealed vector", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    publishFixtureProvider(releaseRoot);
    expect(publish([...publishArgs(releaseRoot, dbPath), "--activate"],
      { JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved" }).code).toBe(0);
    const moved = new AuthorityDb(dbPath, undefined, { fileMustExist: true });
    try {
      moved.db.prepare("DELETE FROM schema_migrations WHERE id=(SELECT MAX(id) FROM schema_migrations)").run();
    } finally {
      moved.close();
    }
    await expect(execute(["release", "rollback", "--to", shared.sourceHead,
      "--release-root", releaseRoot, "--db", dbPath, "--dry-run"]))
      .rejects.toMatchObject({ code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
    expect(readlinkSync(join(releaseRoot, "current"))).toBe(`releases/${shared.sourceHead}`);
  }, 600_000);

  it("refuses a package whose receipt carries no committed source tree", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const bare = await fixturePackage({ withoutProvenance: true });
    const result = publish(["--package", bare.root, "--receipt-sha256", bare.pin,
      "--release-root", releaseRoot, "--db", dbPath, "--dashboard-url", dashboardUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("PACKAGE_RELEASE_SOURCE_TREE_ABSENT");
    expect(existsSync(join(releaseRoot, "releases", bare.sourceHead))).toBe(false);
  }, 600_000);

  it("refuses when a gate fails and publishes nothing at all", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const result = publish(["--package", shared.root, "--receipt-sha256", shared.pin,
      "--release-root", releaseRoot, "--db", dbPath,
      "--dashboard-url", "http://127.0.0.1:1/api/v1/health", "--activate"],
      { JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PACKAGE_RELEASE_GATES_FAILED");
    expect(existsSync(join(releaseRoot, "current"))).toBe(false);
    expect(existsSync(join(releaseRoot, "receipts", `${shared.sourceHead}.json`))).toBe(false);
    // The gates run on the stage, before the rename: a failing gate leaves no release directory
    // behind, so the retry is the same command and not a manual removal.
    expect(existsSync(join(releaseRoot, "releases", shared.sourceHead))).toBe(false);
    expect(readdirSync(join(releaseRoot, "releases"))).toEqual([]);

    const retried = publish(publishArgs(releaseRoot, dbPath));
    expect({ code: retried.code, stderr: retried.stderr }).toEqual({ code: 0, stderr: "" });
  }, 900_000);

  it("gates the phase it was told, recording it in the receipt", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const published = JSON.parse(publish(publishArgs(releaseRoot, dbPath)).stdout);
    expect(JSON.parse(readFileSync(published.receipt, "utf8")).gates.report.phase).toBe("post-activation");

    const rehearsal = join(scratch("publish-rehearsal-"), "rehearsal.json");
    await execute(["db", "migrate", "--rehearse", dbPath, "--rehearsal-receipt", rehearsal]);
    const second = await fixturePackage({ head: "8".repeat(40), tree: "9".repeat(40) });
    const preActivation = publish(["--package", second.root, "--receipt-sha256", second.pin,
      "--release-root", releaseRoot, "--db", dbPath, "--dashboard-url", dashboardUrl,
      "--rehearsal-receipt", rehearsal]);
    expect({ code: preActivation.code, stderr: preActivation.stderr }).toEqual({ code: 0, stderr: "" });
    const receipt = JSON.parse(readFileSync(JSON.parse(preActivation.stdout).receipt, "utf8"));
    expect(receipt.gates.report).toMatchObject({ ok: true, phase: "pre-activation", failed: [] });
  }, 900_000);

  it("refuses a receipt-less release directory and unpublishes only that one", async () => {
    const releaseRoot = scratch("publish-root-");
    const dbPath = await gateableDatabase();
    const interrupted = join(releaseRoot, "releases", shared.sourceHead);
    mkdirSync(interrupted, { recursive: true });
    writeFileSync(join(interrupted, "release.manifest.json"), "{}\n");

    const refused = publish(publishArgs(releaseRoot, dbPath));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("PACKAGE_RELEASE_INCOMPLETE_PUBLISH");
    expect(refused.stderr).toContain(`--unpublish ${shared.sourceHead}`);

    // `current` pointing at it, or a receipt beside it, both refuse the removal.
    symlinkSync(`releases/${shared.sourceHead}`, join(releaseRoot, "current"));
    const active = publish(["--unpublish", shared.sourceHead, "--release-root", releaseRoot]);
    expect({ code: active.code, stderr: active.stderr.trim() })
      .toEqual({ code: 1, stderr: "PACKAGE_RELEASE_UNPUBLISH_ACTIVE" });
    rmSync(join(releaseRoot, "current"));
    mkdirSync(join(releaseRoot, "receipts"), { recursive: true });
    writeFileSync(join(releaseRoot, "receipts", `${shared.sourceHead}.json`), "{}\n");
    const receipted = publish(["--unpublish", shared.sourceHead, "--release-root", releaseRoot]);
    expect({ code: receipted.code, stderr: receipted.stderr.trim() })
      .toEqual({ code: 1, stderr: "PACKAGE_RELEASE_UNPUBLISH_RECEIPT_PRESENT" });
    // With a receipt beside it the directory is a published release, refused as already published.
    expect(publish(publishArgs(releaseRoot, dbPath)).stderr.trim()).toBe("PACKAGE_RELEASE_ALREADY_PUBLISHED");
    rmSync(join(releaseRoot, "receipts", `${shared.sourceHead}.json`));

    const removed = publish(["--unpublish", shared.sourceHead, "--release-root", releaseRoot]);
    expect({ code: removed.code, stderr: removed.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, unpublished: shared.sourceHead });
    expect(existsSync(interrupted)).toBe(false);
    expect(publish(["--unpublish", shared.sourceHead, "--release-root", releaseRoot]).stderr.trim())
      .toBe("PACKAGE_RELEASE_UNPUBLISH_ABSENT");

    // Refusing the interrupted publish never made the release unpublishable.
    expect(publish(publishArgs(releaseRoot, dbPath)).code).toBe(0);

    // The removal mode takes nothing else, and it is not a release id unless it is 40 hex.
    expect(publish(["--unpublish", "nothex", "--release-root", releaseRoot]).code).toBe(2);
    expect(publish(["--unpublish", shared.sourceHead, "--release-root", releaseRoot,
      "--db", dbPath]).code).toBe(2);
    expect(publish(["--unpublish", shared.sourceHead]).code).toBe(2);
  }, 900_000);
});
