import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "ops", "cleanup-test-artifacts.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("guarded test artifact cleanup", () => {
  it("removes only the exact project temp root contents and named shared-memory test families", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-cleanup-fixture-"));
    roots.push(root);
    const runtime = join(root, "project", ".runtime-tmp");
    const shm = join(root, "shm");
    mkdirSync(join(runtime, "verify", "nested"), { recursive: true });
    mkdirSync(join(shm, "jarvis-test-one"), { recursive: true });
    mkdirSync(join(shm, "orca-jarvis-key-tests"), { recursive: true });
    mkdirSync(join(shm, "task36-run-one"), { recursive: true });
    mkdirSync(join(shm, "other-project"), { recursive: true });
    writeFileSync(join(runtime, "verify", "nested", "result.log"), "x".repeat(2_048));
    writeFileSync(join(shm, "jarvis-test-one", "fixture"), "x");
    writeFileSync(join(shm, "other-project", "keep"), "keep");

    const result = spawnSync(process.execPath, [SCRIPT, "--fixture-root", root, "--apply"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    const output: unknown = JSON.parse(result.stdout);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(output).toMatchObject({ ok: true, removed_entries: 4 });
    expect(readdirSync(runtime)).toEqual([]);
    expect(existsSync(join(shm, "jarvis-test-one"))).toBe(false);
    expect(existsSync(join(shm, "orca-jarvis-key-tests"))).toBe(false);
    expect(existsSync(join(shm, "task36-run-one"))).toBe(false);
    expect(readFileSync(join(shm, "other-project", "keep"), "utf8")).toBe("keep");
  });

  it("requires an explicit apply mode and never names operational state families", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--production"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TEST_ARTIFACT_CLEANUP_APPLY_REQUIRED");
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/\.shipping|\.chatgpt2codex|\.omo|backups|releases|jarvis\.sqlite/u);
  });
});
