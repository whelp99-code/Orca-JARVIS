import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { protectedRoots } from "../../src/personal-os-protected-paths.js";
import { snapshotLivePaths } from "../../src/personal-os-rehearsal-live-path.js";
import { resolveProviderSource } from "../../src/personal-os-rehearsal-provider.js";
import { runPersonalOsRehearsal, type RehearsalDependencies } from "../../src/personal-os-rehearsal.js";
import { renderIsolatedUnits } from "../../src/personal-os-rehearsal-units.js";
import { personalOsRehearsalDependencies, personalOsRehearsalProviderSource, personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    ...Object.fromEntries(Object.entries(actual)
      .filter(([name, value]) => name.endsWith("Sync") && typeof value === "function")
      .map(([name, value]) => [name, vi.fn(value as (...args: any[]) => any)])),
  };
});

const SOURCE_ROOT = process.cwd();
const SOURCE_BUILD_METADATA = join(SOURCE_ROOT, "build-metadata.json");
const SCRIPT = join(process.cwd(), "scripts/personal-os-release-rehearsal.mjs");
const FIXTURE = join(process.cwd(), "test/fixtures/personal-os/full-loop.json");
const CLOCK = "2026-08-27T07:15:00+09:00";
const scratchRoots: string[] = [];
let dependencies: RehearsalDependencies;
const blockedStats: string[] = [];
const blockedReads: string[] = [];
const ACTUAL_RELEASE_ROOTS = [...new Set([
  ...protectedRoots(), ...protectedRoots({}),
  "/home/jm/.local/state/orca-jarvis/authority",
  "/var/lib/jarvis-svc",
  "/opt/jarvis-runtime",
  "/home/jm/.local/state/orca-jarvis-phone-gateway",
  "/home/jm/.config/systemd/user/jm-jarvis.service",
])];

async function expectProtectedBeforeFilesystem(releaseRoot: string, scenario?: string): Promise<void> {
  const attempted: string[] = [];
  const restore: (() => void)[] = [];
  // Fence every synchronous filesystem operation, including mkdir/open/write, before
  // exercising an actual path string. The vulnerable runner cannot reach a real syscall.
  for (const [name, operation] of Object.entries(fs)) {
    if (!name.endsWith("Sync") || !vi.isMockFunction(operation)) continue;
    const implementation = operation.getMockImplementation()!;
    operation.mockImplementation(() => {
      attempted.push(name);
      throw new Error(`TEST_FILESYSTEM_BEFORE_PROTECTION:${name}`);
    });
    restore.push(() => { operation.mockImplementation(implementation); });
  }
  try {
    let failure: unknown;
    try {
      await runPersonalOsRehearsal({
        fixturePath: FIXTURE, clock: CLOCK, releaseRoot,
        ...(scenario === undefined ? {} : { scenario }),
      }, dependencies);
    } catch (error) { failure = error; }
    expect({
      code: failure instanceof PersonalOsError ? failure.code : null,
      filesystem_attempts: attempted,
    }).toEqual({ code: "E_PROTECTED_ROOT", filesystem_attempts: [] });
  } finally {
    for (const reset of restore) reset();
  }
}

function isScratchPath(path: string): boolean {
  return scratchRoots.some(root => path === root || path.startsWith(`${root}/`));
}

beforeEach(async () => {
  const deployment = root();
  dependencies = personalOsRehearsalDependencies(deployment);
  vi.stubEnv("JARVIS_REHEARSAL_PROVIDER_SOURCE", personalOsRehearsalProviderSource(deployment));
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const path = String(args[0]);
    // Source-loaded runtime identity probes this one file, even when it is absent.
    // Do not allow arbitrary source-root stats or deployment-root observations.
    if (!isScratchPath(path) && path !== SOURCE_BUILD_METADATA) {
      blockedStats.push(path);
      throw new Error("rehearsal test attempted a non-synthetic stat");
    }
    return actual.lstatSync(...args);
  }) as typeof fs.lstatSync);
  function assertReadable(path: fs.PathLike | number): void {
    const value = String(path);
    if (!isScratchPath(value) && !value.startsWith(`${SOURCE_ROOT}/`)) {
      blockedReads.push(value);
      throw new Error("rehearsal test attempted a non-source, non-synthetic read");
    }
  }
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    assertReadable(args[0]);
    return actual.readFileSync(...args);
  }) as typeof fs.readFileSync);
  vi.mocked(fs.existsSync).mockImplementation(path => {
    // personalOsScratch checks this public mount before allocating a tracked root.
    if (path !== "/dev/shm") assertReadable(path);
    return actual.existsSync(path);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const root of scratchRoots.splice(0)) removeScratch(root);
  expect(blockedStats.splice(0)).toEqual([]);
  expect(blockedReads.splice(0)).toEqual([]);
});

function root(): string {
  const releaseRoot = personalOsScratch("jarvis-task36-");
  scratchRoots.push(releaseRoot);
  return releaseRoot;
}

describe("personal-OS release rehearsal", () => {
  describe.each([undefined, "expired-passkey"])("security boundary scenario=%s", scenario => {
    it.each(ACTUAL_RELEASE_ROOTS)("rejects actual releaseRoot %s before any filesystem call", async releaseRoot => {
      await expectProtectedBeforeFilesystem(releaseRoot, scenario);
    });

    it.each(["named", "live-unit"])("retains the synthetic %s exclusion without replacing actual roots", async kind => {
      const releaseRoot = kind === "named" ? dependencies.namedRoots![0]! : dependencies.liveUnitPath!;
      await expectProtectedBeforeFilesystem(releaseRoot, scenario);
    });

    it("retains the actual process-configured deployment root", async () => {
      const releaseRoot = join(root(), "actual-configured-state");
      vi.stubEnv("JARVIS_STATE_ROOT", releaseRoot);
      await expectProtectedBeforeFilesystem(releaseRoot, scenario);
    });
  });

  it("selects the test-owned vendored provider without probing the owner worktree", () => {
    const source = resolveProviderSource();
    expect(isScratchPath(source)).toBe(true);
    expect(source).toBe(process.env["JARVIS_REHEARSAL_PROVIDER_SOURCE"]);
    expect(existsSync(join(source, ".git"))).toBe(true);
    expect(blockedReads).toEqual([]);
  });

  it("allows only the exact source build metadata stat outside scratch", () => {
    try { fs.lstatSync(SOURCE_BUILD_METADATA); }
    catch (error) { expect(error).toMatchObject({ code: "ENOENT" }); }
    expect(blockedStats).toEqual([]);
    const other = join(SOURCE_ROOT, "not-build-metadata.json");
    expect(() => fs.lstatSync(other)).toThrow("non-synthetic stat");
    expect(blockedStats.splice(0)).toEqual([other]);
  });

  it("blocks actual deployment snapshots and live unit reads before filesystem access", () => {
    const observed = snapshotLivePaths();
    const paths = observed.map(item => item.path);
    expect(paths).toContain("/var/lib/jarvis-svc");
    expect(paths).toContain("/home/jm/.config/systemd/user/jm-jarvis.service");
    for (const path of protectedRoots()) expect(paths).toContain(path);
    expect(blockedStats.splice(0)).toEqual(paths);
    expect(observed.every(item => !item.present)).toBe(true);
    for (const path of paths) {
      expect(() => fs.readFileSync(path)).toThrow("non-source, non-synthetic read");
      expect(() => fs.existsSync(path)).toThrow("non-source, non-synthetic read");
    }
    expect(blockedReads.splice(0)).toEqual(paths.flatMap(path => [path, path]));
  });

  it("refuses a synthetic protected release root before creating files", async () => {
    const protectedRoot = protectedRoots(dependencies.environment)[0]!;
    await expect(runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: CLOCK,
      releaseRoot: join(protectedRoot, "release"),
    }, dependencies)).rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
    expect(existsSync(join(protectedRoot, "release"))).toBe(false);
  });

  it("does not emit PERSONAL_OS_REHEARSAL_OK when the payload CLI is a stub", async () => {
    const source = root();
    const releaseRoot = root();
    mkdirSync(join(source, "dist/src"), { recursive: true });
    mkdirSync(join(source, "migrations"), { recursive: true });
    writeFileSync(join(source, "package.json"), "{\n");
    writeFileSync(join(source, "dist/src/cli.js"), "export {};\n");
    await expect(runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: CLOCK,
      releaseRoot,
      sourceRoot: source,
    }, dependencies)).rejects.toBeInstanceOf(PersonalOsError);
  });

  it("rejects an unknown scenario before writing a release", () => {
    const releaseRoot = root();
    const built = spawnSync(process.execPath, [
      SCRIPT, "--fixture", FIXTURE, "--clock", CLOCK, "--release-root", releaseRoot,
      "--scenario", "not-a-scenario", "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    expect(built.status).toBe(2);
    expect(built.stderr).toContain("E_USAGE");
    expect(existsSync(join(releaseRoot, "current"))).toBe(false);
  });

  it("keeps the newer binary when the previous schema range rejects the database", async () => {
    const releaseRoot = root();
    const result = await runPersonalOsRehearsal({
      fixturePath: FIXTURE, clock: CLOCK, releaseRoot, scenario: "schema-incompatible-rollback",
    }, dependencies);
    expect(result.ok).toBe(true);
    if (result.rehearsal !== "PERSONAL_OS_REHEARSAL_SCENARIO_OK") throw new Error("scenario result expected");
    expect(result.scenario).toBe("schema-incompatible-rollback");
    expect(result.outcome).toBe("newer-binary-kept");
    expect(result.unavailable).toMatchObject({ state: "unavailable", capability: "schema" });
    expect(result.events).toEqual({ unauthorized: 0, duplicate: 0, stale_authoritative: 0, deletion_leak: 0 });
    expect(result.live_path_mutation).toBe(false);
    expect(result.current_after).toBe("releases/" + "e".repeat(40));
  });

  it("emits PERSONAL_OS_REHEARSAL_OK only after the isolated stages pass", async () => {
    const releaseRoot = root();
    const result = await runPersonalOsRehearsal({ fixturePath: FIXTURE, clock: CLOCK, releaseRoot }, dependencies);
    if (!result.ok || result.rehearsal !== "PERSONAL_OS_REHEARSAL_OK") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.runtime_validation).toBe("performed");
    expect(result.deployment_ready).toBe(false);
    expect(result.production_activation).toBe("skipped");
    expect(result.events).toEqual({ unauthorized: 0, duplicate: 0, stale_authoritative: 0, deletion_leak: 0 });
    expect(result.live_path_mutation).toBe(false);
    expect(result.client_qa.linux_phone_gateway).toBe("http://127.0.0.1:4176");
    expect(result.client_qa.mac_electron_qa).toBe("not_in_worker_scope");
    if (!("stages" in result)) throw new Error("happy stages missing");
    const boot = result.stages.find(item => item.name === "no-data-boot");
    expect(boot?.ok).toBe(true);
    expect(boot?.actual).toMatchObject({ data_state: "no_data", page_count: 0, booted: true });
    expect(result.current_target).toMatch(/^releases\/[0-9a-f]{40}$/);
    expect(existsSync(join(releaseRoot, "current", "dist/src/cli.js"))).toBe(true);
    expect(existsSync(join(releaseRoot, "units", "jm-jarvis.service"))).toBe(true);
    const unit = readFileSync(join(releaseRoot, "units", "jm-jarvis.service"), "utf8");
    expect(unit).toContain(join(releaseRoot, "current"));
  }, 300_000);

  it("switches authority/current only when the previous range accepts the database", async () => {
    const releaseRoot = root();
    const result = await runPersonalOsRehearsal({
      fixturePath: FIXTURE, clock: CLOCK, releaseRoot, scenario: "rollback",
    }, dependencies);
    expect(result.ok).toBe(true);
    if (result.rehearsal !== "PERSONAL_OS_REHEARSAL_SCENARIO_OK") throw new Error("scenario result expected");
    expect(result.outcome).toBe("current-switched");
    expect(result.current_after).toBe("releases/" + "b".repeat(40));
    expect(readlinkSync(join(releaseRoot, "current"))).toBe("releases/" + "b".repeat(40));
  });

  // This scenario has a real, bounded stage with an await boundary, but no provider build.
  // Writes below occur deterministically between the two real filesystem snapshots.
  function boundedRehearsal(releaseRoot = root()) {
    return runPersonalOsRehearsal({
      fixturePath: FIXTURE, clock: CLOCK, releaseRoot, scenario: "jm-server-offline",
    }, dependencies);
  }

  it("uses only synthetic protected and named snapshot roots", () => {
    const snapshots = snapshotLivePaths(dependencies);
    expect(snapshots.map(item => item.path)).toEqual([
      ...dependencies.namedRoots!, ...protectedRoots(dependencies.environment),
    ]);
    expect(snapshots.every(item => item.present)).toBe(true);
  });

  it("passes the synthetic gate with writes confined to the isolated release", async () => {
    const releaseRoot = root();
    const pending = boundedRehearsal(releaseRoot);
    writeFileSync(join(releaseRoot, "stage-artifact"), "isolated output");
    await expect(pending).resolves.toMatchObject({
      ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", live_path_mutation: false,
    });
  });

  it.each(["protected", "named"] as const)("rejects a synthetic %s root mutation by the test writer", async kind => {
    const watched = kind === "protected"
      ? protectedRoots(dependencies.environment)[0]!
      : dependencies.namedRoots![0]!;
    const pending = boundedRehearsal();
    // A root inode/type change is deterministic even on coarse-mtime filesystems.
    fs.rmdirSync(watched);
    writeFileSync(watched, "unexpected write");
    await expect(pending).rejects.toMatchObject({ code: "E_REHEARSAL_GATE" });
  });

  it("rejects synthetic live unit removal", async () => {
    const pending = boundedRehearsal();
    unlinkSync(dependencies.liveUnitPath!);
    await expect(pending).rejects.toMatchObject({ code: "E_REHEARSAL_GATE" });
  });

  it("rejects a synthetic protected root mtime change with the inode preserved", async () => {
    const watched = protectedRoots(dependencies.environment)[0]!;
    const before = fs.statSync(watched);
    const pending = boundedRehearsal();
    fs.utimesSync(watched, before.atime, new Date(before.mtimeMs + 10_000));
    expect(fs.statSync(watched).ino).toBe(before.ino);
    await expect(pending).rejects.toMatchObject({ code: "E_REHEARSAL_GATE" });
  });

  it("rejects synthetic named symlink replacement without following its target", async () => {
    const link = dependencies.namedRoots![0]!;
    fs.rmdirSync(link);
    const first = root();
    const second = root();
    symlinkSync(first, link);
    const pending = boundedRehearsal();
    // Keep the previous inode alive so the replacement cannot reuse it.
    fs.renameSync(link, `${link}.previous`);
    symlinkSync(second, link);
    await expect(pending).rejects.toMatchObject({ code: "E_REHEARSAL_GATE" });
    expect(fs.readdirSync(first)).toEqual([]);
    expect(fs.readdirSync(second)).toEqual([]);
  });

  it("rejects a release nested in a synthetic protected symlink boundary", async () => {
    const protectedRoot = protectedRoots(dependencies.environment)[0]!;
    fs.rmdirSync(protectedRoot);
    const target = root();
    symlinkSync(target, protectedRoot);
    await expect(boundedRehearsal(join(protectedRoot, "release")))
      .rejects.toMatchObject({ code: "E_PROTECTED_ROOT" });
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("renders units against the synthetic live unit without reading an installed unit", () => {
    const releaseRoot = root();
    const rendered = renderIsolatedUnits({
      releaseRoot, dbPath: join(releaseRoot, "db.sqlite"),
      providerCurrent: join(releaseRoot, "provider/current"), liveUnitPath: dependencies.liveUnitPath,
    });
    expect(rendered.liveUnit).toEqual({
      path: dependencies.liveUnitPath, present: true, worktreeExec: false, applied: false,
    });
    expect(rendered.pointsAtCurrent).toBe(true);
  });
});
