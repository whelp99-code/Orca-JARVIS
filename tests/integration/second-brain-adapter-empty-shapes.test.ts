import { afterEach, describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  createSecondBrainTransport,
  type SecondBrainAdapterBudgets,
  type SecondBrainReadAdapter,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  cleanupFixtures();
});

function adapterFor(
  settings: Readonly<Record<string, unknown>>,
  budgets: SecondBrainAdapterBudgets = {
    max_hits: 2,
    max_excerpt_bytes: 60,
    max_total_bytes: 2_048,
    max_page_bytes: 1_024,
  },
): SecondBrainReadAdapter {
  const value = fixture(settings);
  const transport = createSecondBrainTransport(options(value));
  transports.push(transport);
  return createSecondBrainReadAdapter({
    transport,
    budgets,
    clock: () => new Date("2026-08-28T12:00:00.000Z"),
    max_age_ms: 86_400_000,
    expiry_ms: 172_800_000,
  });
}

async function callAdapter(
  adapter: SecondBrainReadAdapter,
  method: "search" | "recent" | "conflicts" | "page",
): Promise<SecondBrainReadOutcome> {
  switch (method) {
    case "search": return adapter.search("fixture");
    case "recent": return adapter.recentChanges(7);
    case "conflicts": return adapter.openConflicts();
    case "page": return adapter.readPage("wiki/principle");
    default: { const exhaustive: never = method; return exhaustive; }
  }
}

describe("Second Brain exact empty provider shapes", () => {
  it("rejects an empty search list carrying oversized extra metadata", async () => {
    const adapter = adapterFor(
      { adapterScenario: "empty-extra" },
      { max_hits: 2, max_excerpt_bytes: 60, max_total_bytes: 60, max_page_bytes: 1_024 },
    );

    const result = await adapter.search("fixture");

    expect(result).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_AGGREGATE_OVERSIZE",
      checked_at: "2026-08-28T12:00:00.000Z",
    });
  });

  it.each([
    ["search", "sb_search", { results: [] }],
    ["recent", "sb_recent_changes", { changes: [] }],
    ["conflicts", "sb_open_conflicts", { conflicts: [] }],
  ] as const)("preserves exact %s no-data through the public adapter", async (method, providerMethod, value) => {
    const adapter = adapterFor({ emptyResponse: { method: providerMethod, value } });

    const result = await callAdapter(adapter, method);

    expect(result).toEqual({
      kind: "no_data",
      checked_at: "2026-08-28T12:00:00.000Z",
      fresh_until: "2026-08-28T12:01:00.000Z",
    });
  });

  it("rejects a 20000-level stdio provider value without a raw stack error", async () => {
    const adapter = adapterFor({ adapterScenario: "deep-wire" }, {
      max_hits: 2,
      max_excerpt_bytes: 128,
      max_total_bytes: 65_536,
      max_page_bytes: 1_024,
    });

    const result = await adapter.search("deep");

    expect(result).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_PROVIDER_VALUE_INVALID",
      checked_at: "2026-08-28T12:00:00.000Z",
    });
  });

  it.each([
    ["search", "sb_search", { changes: [] }, "SECOND_BRAIN_SEARCH_MALFORMED"],
    ["recent", "sb_recent_changes", { conflicts: [] }, "SECOND_BRAIN_CHANGES_MALFORMED"],
    ["conflicts", "sb_open_conflicts", { results: [] }, "SECOND_BRAIN_CONFLICTS_MALFORMED"],
    ["page", "sb_read_page", {}, "SECOND_BRAIN_PAGE_MALFORMED"],
  ] as const)("rejects the mismatched %s empty shape", async (method, providerMethod, value, code) => {
    const adapter = adapterFor({ emptyResponse: { method: providerMethod, value } });

    const result = await callAdapter(adapter, method);

    expect(result).toEqual({ kind: "invalid", code, checked_at: "2026-08-28T12:00:00.000Z" });
  });
});
