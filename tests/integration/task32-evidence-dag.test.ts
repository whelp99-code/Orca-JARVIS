import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Task 32 evidence DAG", () => {
  it("authenticates both detached root sidecars", () => {
    const root = ".omo/evidence/task-32-remediation-v6";
    const manifest = `${root}/manifest.json`;
    const evidenceRoot = `${root}/evidence-root.json`;
    expect(readFileSync(`${manifest}.sha256`, "utf8").trim()).toBe(sha256(manifest));
    expect(readFileSync(`${evidenceRoot}.sha256`, "utf8").trim()).toBe(sha256(evidenceRoot));
  });
});
