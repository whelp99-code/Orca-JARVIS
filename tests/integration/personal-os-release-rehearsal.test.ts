import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { runPersonalOsRehearsal } from "../../src/personal-os-rehearsal.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const SCRIPT = join(process.cwd(), "scripts/personal-os-release-rehearsal.mjs");
const FIXTURE = join(process.cwd(), "test/fixtures/personal-os/full-loop.json");
const CLOCK = "2026-08-27T07:15:00+09:00";
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

function root(): string {
  const releaseRoot = personalOsScratch("jarvis-task36-");
  scratchRoots.push(releaseRoot);
  return releaseRoot;
}

describe("personal-OS release rehearsal", () => {
  it("refuses a production release root before creating files", async () => {
    await expect(runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: CLOCK,
      releaseRoot: "/home/jm/.local/state/orca-jarvis/authority",
    })).rejects.toBeInstanceOf(PersonalOsError);
    expect(existsSync("/home/jm/.local/state/orca-jarvis/authority/.task36-rehearsal")).toBe(false);
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
    })).rejects.toBeInstanceOf(PersonalOsError);
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
    });
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
    const result = await runPersonalOsRehearsal({ fixturePath: FIXTURE, clock: CLOCK, releaseRoot });
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
    });
    expect(result.ok).toBe(true);
    if (result.rehearsal !== "PERSONAL_OS_REHEARSAL_SCENARIO_OK") throw new Error("scenario result expected");
    expect(result.outcome).toBe("current-switched");
    expect(result.current_after).toBe("releases/" + "b".repeat(40));
    expect(readlinkSync(join(releaseRoot, "current"))).toBe("releases/" + "b".repeat(40));
  });
});
