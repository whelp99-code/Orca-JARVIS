import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const generatedPaths = [
  "dist/src/cli.js",
  "dist/migrations/001_authority.sql",
  ".jarvis-runtime/jarvis.sqlite",
  ".jarvis-runtime/jarvis.sqlite-wal",
  ".jarvis-runtime/backups/snapshot.sqlite",
  "state/CURRENT_STATE.json",
  "state/CURRENT_STATE.md",
];

describe("repository hygiene", () => {
  it("keeps generated runtime artifacts ignored by git", () => {
    const failures = generatedPaths.flatMap(path => {
      const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], { cwd: process.cwd(), encoding: "utf8" });
      return result.status === 0 ? [] : [{ path, status: result.status, stderr: result.stderr.trim() }];
    });
    expect(failures).toEqual([]);
  });
});
