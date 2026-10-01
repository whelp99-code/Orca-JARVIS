import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TASK12_PARENT = "f78644beee512f0a7418f76d8b46f276125f72d3";
// Reviewability bound for the Task 12 delta only. Later product growth is not this contract.
// Landed in a28434b (2026-08-29, fix(capabilities): bind actual readiness contracts).
const TASK12_LANDING = "a28434b";
const PRODUCTION_EXTENSION = /\.(?:ts|mts|cts|tsx)$/;

describe("Task 12 runtime reviewability", () => {
  it("enforces production module limits across every TypeScript extension", () => {
    const changed = execFileSync("git", ["diff", "--name-only", `${TASK12_PARENT}..${TASK12_LANDING}`, "--", "src"], {
      encoding: "utf8",
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], {
      encoding: "utf8",
    });
    const modules = [...new Set(`${changed}\n${untracked}`.trim().split("\n"))]
      .filter(path => PRODUCTION_EXTENSION.test(path))
      .sort();
    const offenders = modules.flatMap(path => {
      const lines = readFileSync(path, "utf8").split("\n");
      const pureLines = lines.filter(line => line.trim() !== "").length;
      const maximumLine = Math.max(...lines.map(line => line.length));
      return pureLines > 250 || maximumLine > 160 ? [{ path, pureLines, maximumLine }] : [];
    });
    expect({ modules, offenders }).toEqual({
      modules: expect.arrayContaining(["src/cli-runtime.mts"]),
      offenders: [],
    });
  });

  it("keeps every compiler configuration explicit about all TypeScript-family extensions", () => {
    const configs = ["tsconfig.json", "tsconfig.dashboard.json", "tsconfig.e2e.json"];
    const missing = configs.flatMap(path => {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const include = typeof parsed === "object" && parsed !== null && Array.isArray(Reflect.get(parsed, "include"))
        ? Reflect.get(parsed, "include")
        : [];
      const joined = JSON.stringify(include);
      return [".ts", ".mts", ".cts", ".tsx"].flatMap(extension => joined.includes(extension) ? [] : [`${path}:${extension}`]);
    });
    expect(missing).toEqual([]);
  });
});
