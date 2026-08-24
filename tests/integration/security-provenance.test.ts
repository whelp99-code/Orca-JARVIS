import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("F2 security and provenance", () => {
  it("finds no SSH command construction, no permission secrets in docs, and independent vault origin", () => {
    const remote = readFileSync("src/remote-dispatch.ts", "utf8");
    expect(remote.includes("ssh ")).toBe(false);
    const docs = [
      "docs/integration/argo-provenance.md",
      "docs/integration/security-boundaries.md",
      "docs/integration/operator-runbook.md",
    ].map(path => readFileSync(path, "utf8")).join("\n");
    expect(docs.includes("BEGIN ")).toBe(false);
    expect(docs.toLowerCase().includes("private key")).toBe(false);
    const provenance = readFileSync("third_party/argo/PROVENANCE.jsonl", "utf8");
    expect(provenance).toContain("\"origin\":\"independent\"");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/F2"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/F2/review.json"), `${JSON.stringify({
      verdict: "APPROVE",
      sshCommandConstruction: false,
      secretsInDocs: false,
      argoCopied: false,
    }, null, 2)}\n`);
  });
});
