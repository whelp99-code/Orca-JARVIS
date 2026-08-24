import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const generatedPaths = [
  "dist/src/cli.js",
  "dist/migrations/001_authority.sql",
  ".jarvis-runtime/jarvis.sqlite",
  ".jarvis-runtime/jarvis.sqlite-wal",
  ".jarvis-runtime/backups/snapshot.sqlite",
  ".jarvis-runtime/control-center/.stage.tmp/release",
  "state/CURRENT_STATE.json",
  "state/CURRENT_STATE.md",
  "playwright-report/index.html",
  "test-results/.last-run.json",
  ".tmp-e2e/seeded-4174.json",
] as const;

const repoRoot = process.cwd();
const vitestEntry = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

function runVitestOn(fileFilter: string, extraArgs: readonly string[] = []) {
  const result = spawnSync(
    process.execPath,
    [vitestEntry, "run", "--no-file-parallelism", ...extraArgs, fileFilter],
    { cwd: repoRoot, encoding: "utf8", timeout: 90_000 },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("repository hygiene", () => {
  it("keeps generated runtime artifacts ignored by git", () => {
    const failures = generatedPaths.flatMap(path => {
      const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], { cwd: process.cwd(), encoding: "utf8" });
      return result.status === 0 ? [] : [{ path, status: result.status, stderr: result.stderr.trim() }];
    });
    expect(failures).toEqual([]);
  });

  it("never discovers test files under .omo even when targeted directly", () => {
    const fixtureDir = join(repoRoot, ".omo", "tmp-hygiene-discovery-fixture");
    const fixtureFile = join(fixtureDir, "sneaky.test.ts");
    try {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(
        fixtureFile,
        [
          'import { expect, it } from "vitest";',
          'it("omo-fixture-must-never-run", () => { expect(1).toBe(2); });',
          "",
        ].join("\n"),
      );
      const { status, output } = runVitestOn(
        ".omo/tmp-hygiene-discovery-fixture/sneaky.test.ts",
        ["--passWithNoTests"],
      );
      expect(output).toContain("No test files found");
      expect(output).not.toContain("omo-fixture-must-never-run");
      expect(status).toBe(0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("still discovers and reports a failing product test under tests/", () => {
    const fixtureFile = join(
      repoRoot,
      "tests",
      "integration",
      "tmp-intentional-failure-fixture.test.ts",
    );
    try {
      writeFileSync(
        fixtureFile,
        [
          'import { expect, it } from "vitest";',
          'it("intentional-product-test-failure", () => { expect(1).toBe(2); });',
          "",
        ].join("\n"),
      );
      const { status, output } = runVitestOn(
        "tests/integration/tmp-intentional-failure-fixture.test.ts",
      );
      expect(output).toContain("intentional-product-test-failure");
      expect(status).not.toBe(0);
    } finally {
      rmSync(fixtureFile, { force: true });
    }
  }, 120_000);
});
