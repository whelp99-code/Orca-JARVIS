import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryReadFence } from "../../src/second-brain-effect-v2.js";
import { parseScopedSecondBrainResponse } from "../../src/second-brain-scoped-read.js";
import { REFERENCE_GENERATION as generation, REFERENCE_NOW as now, REFERENCE_RECORD as record } from "../fixtures/memory-reference-provider.js";
const hash = `sha256:${"a".repeat(64)}`;
const fence = createMemoryReadFence({ provider_instance_id: generation.provider_instance_id, purpose: "memory_read", operation: "read",
  tombstone_sequence: 0, tombstone_set_root: generation.tombstone_set_root, issued_at: now.toISOString(), not_before: now.toISOString(),
  expires_at: "2026-08-31T03:31:00.000Z", nonce: "nonce:test", signing_key_id: "key:test" }, generateKeyPairSync("ed25519").privateKey);
const expected = { method: "sb_read_page" as const, page_id: "wiki/reference", limit: 64, request_digest: hash,
  access_claim_digest: hash, authorized_until: "2026-08-31T03:30:30.000Z", fence, checked_at: now,
  budgets: { max_hits: 10, max_excerpt_bytes: 4096, max_total_bytes: 100000, max_page_bytes: 20000 }, max_age_ms: 86400000, expiry_ms: 172800000 };
const base = { profile: "scoped-record-read-v1", ...generation, request_digest: hash, access_claim_digest: hash };
const response = { ...base, page_id: "wiki/reference", content_digest: hash, records: [record] };
const search = { ...base, results: [{ page_id: "wiki/reference", content_digest: hash, record }] };
const invalid = "SECOND_BRAIN_SCOPED_RESPONSE_INVALID";
describe("scoped response consumer", () => {
  it("retains real record identity and content version for direct and search reads", () => {
    for (const parsed of [parseScopedSecondBrainResponse(response, expected),
      parseScopedSecondBrainResponse(search, { ...expected, method: "sb_search", limit: 1 })]) {
      expect(parsed.generation).toEqual(generation);
      const page = parsed.pages[0]!;
      expect(page.parsed.kind).toBe("current");
      if (page.parsed.kind !== "current") throw new Error("expected current");
      expect(page.parsed.evidence[0]).toMatchObject({ source_version: hash, excerpt: record.record_text,
        authority: "none", record: { record_id: record.record_id, record_digest: record.record_digest } });
    }
  });
  it.each([
    { request_digest: `sha256:${"b".repeat(64)}` }, { access_claim_digest: `sha256:${"b".repeat(64)}` },
    { page_id: "wiki/other" }, { provider_instance_id: "provider:other" }, { tombstone_sequence: 1 },
    { content_digest: "not-a-digest" }, { records: [{ ...record, record_text: "tampered" }] },
    { records: [{ ...record, extra: true }] }, { extra: true }, { generation_id: undefined },
  ])("rejects response substitution or malformed content %j", change => {
    expect(() => parseScopedSecondBrainResponse({ ...response, ...change }, expected)).toThrow(invalid);
  });
  it("rejects expired authorization even while its read fence remains live", () => {
    expect(() => parseScopedSecondBrainResponse(response, { ...expected, checked_at: new Date(expected.authorized_until) })).toThrow(invalid);
    expect(() => parseScopedSecondBrainResponse(response, { ...expected, checked_at: new Date(fence.expires_at) })).toThrow(invalid);
  });
  it("enforces byte, hit and caller limits", () => {
    expect(() => parseScopedSecondBrainResponse(response, { ...expected, budgets: { ...expected.budgets, max_page_bytes: 100 } })).toThrow(invalid);
    expect(() => parseScopedSecondBrainResponse(response, { ...expected, budgets: { ...expected.budgets, max_total_bytes: 100 } })).toThrow(invalid);
    expect(() => parseScopedSecondBrainResponse({ ...search, results: [...search.results, ...search.results] }, { ...expected, method: "sb_search", limit: 1 })).toThrow(invalid);
    expect(() => parseScopedSecondBrainResponse(search, { ...expected, method: "sb_search", budgets: { ...expected.budgets, max_hits: 0 } })).toThrow(invalid);
  });
  it("rejects mixed versions of the same page and unsafe page IDs", () => {
    const options = { ...expected, method: "sb_search" as const, limit: 2 };
    expect(() => parseScopedSecondBrainResponse({ ...search, results: [...search.results,
      { ...search.results[0], content_digest: `sha256:${"b".repeat(64)}` }] }, options)).toThrow(invalid);
    expect(() => parseScopedSecondBrainResponse({ ...search, results: [{ ...search.results[0], page_id: "wiki/../secret" }] }, options)).toThrow(invalid);
  });
  it("accepts an empty authorized search without inventing evidence", () => {
    expect(parseScopedSecondBrainResponse({ ...base, results: [] }, { ...expected, method: "sb_search", limit: 1 }).pages).toEqual([]);
  });
});
