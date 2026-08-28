import { afterEach, describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  createSecondBrainTransport,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  cleanupFixtures();
});

function adapterForSettings(settings: Readonly<Record<string, unknown>>) {
  const child = fixture(settings);
  const transport = createSecondBrainTransport(options(child));
  transports.push(transport);
  return createSecondBrainReadAdapter({
    transport,
    budgets: { max_hits: 2, max_excerpt_bytes: 128, max_total_bytes: 65_536, max_page_bytes: 1_024 },
    clock: () => new Date("2026-08-28T12:00:00.000Z"),
    max_age_ms: 86_400_000,
    expiry_ms: 172_800_000,
  });
}

function adapterFor(text: string) {
  return adapterForSettings({ rawToolText: { method: "sb_search", text } });
}

function expectProviderInvalid(result: SecondBrainReadOutcome): void {
  expect(result).toEqual({
    kind: "invalid",
    code: "SECOND_BRAIN_PROVIDER_VALUE_INVALID",
    checked_at: "2026-08-28T12:00:00.000Z",
  });
  expect("evidence" in result).toBe(false);
  expect("conflicts" in result).toBe(false);
}

describe("Second Brain strict provider JSON public boundary", () => {
  it("rejects duplicate keys at every depth before no-data normalization", async () => {
    const duplicatePayloads = [
      '{"results":[{"page_id":"p"}],"results":[]}',
      '{"results":[],"results":[{"page_id":"p"}]}',
      '{"results":[{"page_id":"p","page_id":"q"}]}',
      '{"results":[{"nested":{"key":1,"key":2}}]}',
      '{"results":[],"\\u0072esults":[]}',
      '{"results":[{"name":"x","n\\u0061me":"y"}]}',
      '{"results":[{"😀":1,"\\uD83D\\uDE00":2}]}',
    ];

    const rejected = await Promise.all(duplicatePayloads.map(payload => adapterFor(payload).search("fixture")));
    for (const result of rejected) expectProviderInvalid(result);
    await expect(adapterFor('{"results":[]}').search("fixture")).resolves.toEqual({
      kind: "no_data",
      checked_at: "2026-08-28T12:00:00.000Z",
      fresh_until: "2026-08-28T12:01:00.000Z",
    });
  });

  it("rejects malformed provider JSON and duplicate JSON-RPC envelope keys deterministically", async () => {
    const malformed = [
      '{"results":01}',
      '{"results":"\\u00xz"}',
      '{"results":[]} trailing',
      '{"results":"control\u0001"}',
      '{"results":1e999}',
    ];
    const results = await Promise.all(malformed.map(payload => adapterFor(payload).search("fixture")));
    for (const result of results) expectProviderInvalid(result);

    await expect(adapterForSettings({ duplicateResultEnvelope: true }).search("fixture")).resolves.toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_MALFORMED_FRAME",
      checked_at: "2026-08-28T12:00:00.000Z",
    });
  });
});
