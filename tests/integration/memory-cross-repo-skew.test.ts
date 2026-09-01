import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { snapshotMemoryWriteArguments } from "../../src/memory-effect-write-request.js";

const fixture = "contracts/second-brain-mcp-v1.json";

describe("provider-first cross-repository skew", () => {
  it("keeps old V1 bytes accepted by the new schema-4 provider fixture", () => {
    const contract = JSON.parse(readFileSync(fixture, "utf8")) as {
      readonly schema_version: number; readonly tools: Record<string, unknown>;
      readonly vectors: { readonly tool_count: number };
      readonly application: { readonly implementation_commit: string };
    };
    expect(contract.schema_version).toBe(4);
    expect(Object.keys(contract.tools).sort()).toHaveLength(9);
    const request = ((contract.tools.sb_write_request as { readonly happy: {
      readonly arguments: { readonly request: unknown } } }).happy.arguments.request);
    expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
    expect(contract.application.implementation_commit).toBe("313adfb90accb6b9687d4826c305887066166170");
  });

  it("pins producer, consumer, and sidecar to one digest", () => {
    const payload = readFileSync(fixture);
    const digest = createHash("sha256").update(payload).digest("hex");
    expect(readFileSync(`${fixture}.sha256`, "ascii")).toBe(`${digest}\n`);
    expect(consumeSecondBrainContract(fixture).digest).toBe(digest);
    expect(digest).toBe("ae2e4b4f41ade29e8781e47e60dad6ddb17ed8cea516b82ccd16454acd5dc3e0");
  });
});
