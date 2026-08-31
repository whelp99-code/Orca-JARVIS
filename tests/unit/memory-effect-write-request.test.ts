import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshotMemoryWriteArguments } from "../../src/memory-effect-write-request.js";

type Contract = {
  readonly tools: {
    readonly sb_write_request: {
      readonly happy: { readonly arguments: { readonly request: unknown } };
    };
  };
};

const contract = JSON.parse(
  readFileSync("contracts/second-brain-mcp-v1.json", "utf8"),
) as Contract;

describe("memory effect write boundary characterization", () => {
  it("preserves the frozen Task 29 V1 request bytes", () => {
    const request = contract.tools.sb_write_request.happy.arguments.request;

    expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
  });

  it("accepts exactly 21 V2 root keys and rejects unknown nested keys", () => {
    const request = (contract as Contract & { readonly vectors: {
      readonly correction: { readonly request: Record<string, unknown> } } }).vectors.correction.request;
    expect(Object.keys(request)).toHaveLength(21);
    expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
    expect(snapshotMemoryWriteArguments({ request: { ...request, unknown: true } })).toBeUndefined();
  });
});
