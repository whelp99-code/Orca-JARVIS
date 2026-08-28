import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ALLOWED = new Set([
  "src/cli-command-context.ts",
  "src/cli-command-input.ts",
  "src/cli-control-commands.ts",
  "src/cli-core-commands.ts",
  "src/cli-gjc-commands.ts",
  "src/cli-live-commands.ts",
  "src/cli-pre-gjc-commands.ts",
  "src/cli-runtime.mts",
  "src/cli-state-commands.ts",
  "src/dashboard/api-routes.ts",
  "src/dashboard/invalid-clock-overview.ts",
  "src/dashboard/overview-cards.ts",
  "src/dashboard/read-model.ts",
  "src/doctor.ts",
  "src/capabilities.ts",
  "src/second-brain-readiness-config.ts",
  "src/second-brain-readiness-handshake.ts",
  "src/second-brain-readiness-invalid-clock.ts",
  "src/second-brain-readiness-report.ts",
  "src/second-brain-readiness-runtime.ts",
  "src/second-brain-readiness.ts",
  "tests/integration/second-brain-readiness-surfaces.test.ts",
  "tests/integration/task12-owned-dirt.test.ts",
  "tests/integration/task12-runtime-reviewability.test.ts",
  "tests/unit/second-brain-readiness-authoritative.test.ts",
  "tests/unit/second-brain-readiness-config.test.ts",
  "tests/unit/second-brain-readiness-invalid-clock.test.ts",
  "tests/unit/second-brain-readiness-producer-contract.test.ts",
  "tests/unit/second-brain-readiness-runtime.test.ts",
  "tests/unit/second-brain-readiness.test.ts",
  "tsconfig.dashboard.json",
  "tsconfig.e2e.json",
  "tsconfig.json",
]);

describe("Task 12 sole-writer ownership", () => {
  it("admits only owned remediation paths and requires every source/test path in the index", () => {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const product = status
      .map(line => line.slice(3))
      .filter(path => !path.startsWith(".omo/"));
    const unowned = product.filter(path => !ALLOWED.has(path));
    const untracked = status
      .filter(line => line.startsWith("?? "))
      .map(line => line.slice(3))
      .filter(path => path.startsWith("src/") || path.startsWith("tests/"));
    expect({ unowned, untracked }).toEqual({ unowned: [], untracked: [] });
  });
});
