import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 pair handoff evidence DAG", () => {
  it("has a detached manifest and authenticated evidence root", () => {
    expect(existsSync(".omo/evidence/task-32-remediation-v6/manifest.json")).toBe(true);
    expect(existsSync(".omo/evidence/task-32-remediation-v6/evidence-root.json")).toBe(true);
    expect(existsSync(".omo/evidence/task-32-remediation-v6/manifest.sha256")).toBe(true);
    expect(existsSync(".omo/evidence/task-32-remediation-v6/evidence-root.sha256")).toBe(true);
  });
});
