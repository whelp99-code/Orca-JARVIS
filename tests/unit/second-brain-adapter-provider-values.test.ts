import { describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  SecondBrainTransportError,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { NOW, QueuedTransport } from "../fixtures/second-brain-adapter-fixtures.js";

function reader(value: unknown) {
  return createSecondBrainReadAdapter({
    transport: new QueuedTransport([{ kind: "data", value: { results: [{
      page_id: "wiki/principle",
      section: "small",
      snippet: "small",
      score: 1,
    }], ignored: value } }]),
    budgets: { max_hits: 2, max_excerpt_bytes: 128, max_total_bytes: 65_536, max_page_bytes: 1_024 },
    clock: () => NOW,
    max_age_ms: 86_400_000,
    expiry_ms: 172_800_000,
  });
}

function expectProviderInvalid(result: SecondBrainReadOutcome): void {
  expect(result).toEqual({
    kind: "invalid",
    code: "SECOND_BRAIN_PROVIDER_VALUE_INVALID",
    checked_at: NOW.toISOString(),
  });
}

describe("Second Brain iterative provider values", () => {
  it("returns typed invalid for a 20000-level provider value without stack overflow", async () => {
    let nested: Readonly<Record<string, unknown>> = { leaf: "value" };
    for (let depth = 0; depth < 20_000; depth += 1) nested = { next: nested };

    const result = await reader(nested).search("deep");

    expectProviderInvalid(result);
  });

  it("returns typed invalid for cyclic and unsupported provider values without raw throws", async () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => { throw new TypeError("raw accessor trap"); },
    });
    const trapped = new Proxy({}, {
      ownKeys: () => { throw new TypeError("raw proxy trap"); },
    });
    const sparse = new Array<unknown>(2);
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, index]));
    const unsupported: readonly unknown[] = [
      cycle,
      wide,
      accessor,
      trapped,
      sparse,
      undefined,
      1n,
      Symbol("provider"),
      () => "provider",
      new Date("2026-08-28T00:00:00.000Z"),
      new Map([["key", "value"]]),
      new Set(["value"]),
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];

    for (const value of unsupported) {
      const result = await reader(value).search("unsupported");
      expectProviderInvalid(result);
    }
  });

  it("keeps the isolated search metadata failure before a distinct offline page result", async () => {
    const transport = new QueuedTransport([
      { kind: "data", value: { results: [{
        page_id: "wiki/principle",
        section: "한".repeat(200_000),
        snippet: "small",
        score: 1,
      }] } },
      new SecondBrainTransportError("SECOND_BRAIN_DISCOVERY_FAILED", "unavailable", { generation: 1 }),
    ]);
    const adapter = createSecondBrainReadAdapter({
      transport,
      budgets: { max_hits: 2, max_excerpt_bytes: 60, max_total_bytes: 60, max_page_bytes: 1_024 },
      clock: () => NOW,
      max_age_ms: 86_400_000,
      expiry_ms: 172_800_000,
    });

    const result = await adapter.search("metadata");

    expect(result).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_AGGREGATE_OVERSIZE",
      checked_at: NOW.toISOString(),
    });
    expect(transport.calls.map(call => call.method)).toEqual(["sb_search"]);
  });
});
