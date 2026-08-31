import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { snapshotMemoryWriteArguments } from "../../src/memory-effect-write-request.js";

const fixture = "contracts/second-brain-mcp-v1.json";

describe("provider-first cross-repository skew", () => {
  it("keeps old V1 bytes accepted by the new schema-3 provider fixture", () => {
    const contract = JSON.parse(readFileSync(fixture, "utf8")) as {
      readonly schema_version: number; readonly tools: Record<string, unknown>;
      readonly vectors: { readonly tool_count: number };
      readonly application: { readonly implementation_commit: string };
    };
    expect(contract.schema_version).toBe(3);
    expect(Object.keys(contract.tools).sort()).toHaveLength(9);
    const request = ((contract.tools.sb_write_request as { readonly happy: {
      readonly arguments: { readonly request: unknown } } }).happy.arguments.request);
    expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
    expect(contract.application.implementation_commit).toBe("30cebe1670c0b65dc9832066a09c2c64f8371b20");
  });

  it("pins producer, consumer, and sidecar to one digest", () => {
    const payload = readFileSync(fixture);
    const digest = createHash("sha256").update(payload).digest("hex");
    expect(readFileSync(`${fixture}.sha256`, "ascii")).toBe(`${digest}\n`);
    expect(consumeSecondBrainContract(fixture).digest).toBe(digest);
    expect(digest).toBe("1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe");
  });
});
