import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 fresh acceptance verifier binding", () => {
  it("binds the evidence root to the verifier and current worktree", () => {
    const value: unknown = JSON.parse(
      readFileSync(".omo/evidence/task-32-remediation-v6/evidence-root.json", "utf8"),
    );
    expect(value).toMatchObject({
      schema_version: 1,
      task: "task-32-remediation-v6",
      verifier: { name: "task32-acceptance-final-verifier-v5" },
      worktree: { head: "49a879b574271c0521777442e7c9ca55f967cb2e" },
    });
  });
});
