import { afterEach, describe, expect, it } from "vitest";
import {
  createSecondBrainTransport,
  type SecondBrainOutcome,
  type SecondBrainReadMethod,
} from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  cleanupFixtures();
});

type Schema4ReadMethod = Exclude<SecondBrainReadMethod, "sb_cancellation_status">;
const argumentsByMethod: Readonly<Record<Schema4ReadMethod, Readonly<Record<string, unknown>>>> = {
  sb_search: { query: "fixture" },
  sb_read_page: { id: "wiki/principle" },
  sb_recent_changes: {},
  sb_open_conflicts: {},
  sb_generation_status: {},
  sb_request_status: { request_id: `memeff:req:v2:${"1".repeat(64)}` },
  sb_resolve_memory_target: {
    page_id: "wiki/principle", exact_record: "fixture", source_identity_full: "2".repeat(64),
  },
};

async function call(method: Schema4ReadMethod, value: unknown): Promise<SecondBrainOutcome> {
  const child = fixture({ emptyResponse: { method, value } });
  const transport = createSecondBrainTransport(options(child));
  transports.push(transport);
  return transport.call(method, argumentsByMethod[method]);
}

describe("Second Brain method-specific empty normalization", () => {
  it.each([
    ["sb_search", { results: [] }],
    ["sb_recent_changes", { changes: [] }],
    ["sb_open_conflicts", { conflicts: [] }],
  ] as const)("normalizes the exact %s empty producer shape", async (method, value) => {
    await expect(call(method, value)).resolves.toEqual({ kind: "no_data", reason: "empty_result" });
  });

  it("keeps sb_read_page empty objects as data because the frozen contract has no no-data form", async () => {
    await expect(call("sb_read_page", {})).resolves.toEqual({ kind: "data", value: {} });
  });

  it.each([
    ["extra search field", "sb_search", { results: [], ignored: "metadata" }],
    ["extra recent field", "sb_recent_changes", { changes: [], ignored: "metadata" }],
    ["extra conflict field", "sb_open_conflicts", { conflicts: [], ignored: "metadata" }],
    ["mismatched search field", "sb_search", { changes: [] }],
    ["mismatched recent field", "sb_recent_changes", { conflicts: [] }],
    ["mismatched conflict field", "sb_open_conflicts", { results: [] }],
    ["nonempty search", "sb_search", { results: [{ page_id: "wiki/principle" }] }],
    ["unknown empty field", "sb_search", { unknown: [] }],
  ] as const)("keeps %s as ordinary data", async (_name, method, value) => {
    await expect(call(method, value)).resolves.toEqual({ kind: "data", value });
  });
});
