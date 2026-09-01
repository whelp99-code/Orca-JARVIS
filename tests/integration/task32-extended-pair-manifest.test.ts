import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 extended pair manifest", () => {
  it("contains explicit product and verification domains", () => {
    const value: unknown = JSON.parse(
      readFileSync(".omo/evidence/task-32-remediation-v6/manifest.json", "utf8"),
    );
    expect(value).toMatchObject({
      schema_version: 1,
      product: { repository: "Orca-JARVIS" },
      verification: { focused_files: 32 },
    });
  });
});
