import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  cleanupFixtures();
});

describe("Second Brain adapter over supervised stdio", () => {
  it("retrieves cited evidence through the real fixture process without mutation calls", async () => {
    // Given: a supervised fixture process with provider-shaped search and page responses.
    const value = fixture({ adapterScenario: "happy" });
    const transport = createSecondBrainTransport(options(value));
    transports.push(transport);
    const adapter = createSecondBrainReadAdapter({
      transport,
      budgets: { max_hits: 2, max_excerpt_bytes: 128, max_total_bytes: 4_096, max_page_bytes: 1_024 },
      clock: () => new Date("2026-08-28T12:00:00.000Z"),
      max_age_ms: 86_400_000,
      expiry_ms: 172_800_000,
    });

    // When: the public read seam searches for fixture memory.
    const result = await adapter.search("principle project");

    // Then: both cited facts arrive as bounded evidence and no write was requested.
    expect(result).toMatchObject({ kind: "current", evidence: [
      { page_id: "wiki/principle", sid: "a1b2c3d4", source_ref: "fixture:principle" },
      { page_id: "wiki/project", sid: "bbbbbbbb", source_ref: "fixture:project" },
    ] });
    expect(transport.diagnostics().filter(item => item.method === "sb_write_request")).toEqual([]);
  });
});
