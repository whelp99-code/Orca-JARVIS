import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runPersonalOsRehearsal } from "../../src/personal-os-rehearsal.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const SCRIPT = join(process.cwd(), "scripts/personal-os-release-rehearsal.mjs");
const FIXTURE = join(process.cwd(), "test/fixtures/personal-os/full-loop.json");
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

describe("personal-OS release rehearsal", () => {
  it("builds a checksummed isolated release, restores a fixture DB, and emits the machine OK gate", async () => {
    // Given
    const releaseRoot = personalOsScratch("jarvis-task36-rehearsal-");
    scratchRoots.push(releaseRoot);

    // When
    const result = await runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: "2026-08-27T07:15:00+09:00",
      releaseRoot,
    });

    // Then
    expect(result.ok).toBe(true);
    expect(result.rehearsal).toBe("PERSONAL_OS_REHEARSAL_OK");
    expect(result.production_database).toEqual({
      schema_version: 1,
      lane: "production-database",
      state: "SKIPPED_NOT_AUTHORIZED",
      open_attempts: 0,
      bytes_read: 0,
      copies_created: 0,
    });
    expect(result.current_target).toMatch(/^releases\/[0-9a-f]{40}$/);
    expect(result.virtual_at).toBe("2026-08-26T21:55:00.000Z");
    expect(result.anchor_at).toBe("2026-08-26T22:15:00.000Z");
    expect(existsSync(join(releaseRoot, "current", "release.manifest.json"))).toBe(true);
    expect(existsSync(join(releaseRoot, "handoff", "operator-handoff.json"))).toBe(true);
    expect(result.restore.quick_check).toBe("ok");
    expect(result.systemd_runtime).toBe("SKIPPED_NOT_AUTHORIZED");
    const cli = readFileSync(join(releaseRoot, result.current_target, "dist/src/cli.js"), "utf8");
    expect(cli.trim()).not.toBe("export {};");
    expect(cli).toContain("execute");
    const restored = new Database(result.restore.destPath, { readonly: true, fileMustExist: true });
    const tables = restored.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ readonly name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toContain("schema_migrations");
    expect(names.includes("sentinel")).toBe(false);
    const migrated = restored.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { readonly n: number };
    restored.close();
    expect(migrated.n).toBeGreaterThan(1);
    expect(result.restore.bytes).toBeGreaterThan(12_288);
  });

  it("rejects a production release root before creating files and the CLI wrapper matches the library", async () => {
    // Given
    const isolated = personalOsScratch("jarvis-task36-cli-");
    scratchRoots.push(isolated);

    // When
    await expect(runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: "2026-08-27T07:15:00+09:00",
      releaseRoot: "/home/jm/.local/state/orca-jarvis/authority",
    })).rejects.toBeInstanceOf(PersonalOsError);

    const built = spawnSync(process.execPath, [SCRIPT, "--fixture", FIXTURE, "--clock", "2026-08-27T07:15:00+09:00", "--release-root", isolated, "--json"], {
      encoding: "utf8",
      cwd: process.cwd(),
      timeout: 30_000,
    });

    // Then
    expect(existsSync("/home/jm/.local/state/orca-jarvis/authority/.task36-rehearsal")).toBe(false);
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: "" });
    const parsed = JSON.parse(built.stdout) as { readonly rehearsal: string; readonly ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.rehearsal).toBe("PERSONAL_OS_REHEARSAL_OK");
  });

  it("does not emit PERSONAL_OS_REHEARSAL_OK when the payload CLI is a stub", async () => {
    // Given
    const source = personalOsScratch("jarvis-task36-stub-src-");
    const releaseRoot = personalOsScratch("jarvis-task36-stub-out-");
    scratchRoots.push(source, releaseRoot);
    mkdirSync(join(source, "dist/src"), { recursive: true });
    mkdirSync(join(source, "migrations"), { recursive: true });
    writeFileSync(join(source, "package.json"), "{\n");
    writeFileSync(join(source, "dist/src/cli.js"), "export {};\n");

    // When / Then
    await expect(runPersonalOsRehearsal({
      fixturePath: FIXTURE,
      clock: "2026-08-27T07:15:00+09:00",
      releaseRoot,
      sourceRoot: source,
    })).rejects.toBeInstanceOf(PersonalOsError);
  });
});
