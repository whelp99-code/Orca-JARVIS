import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import { QueuedTransport } from "../fixtures/second-brain-adapter-fixtures.js";

const now = new Date("2026-08-31T00:00:01.000Z");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const generation = { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"a".repeat(64)}`,
  generation_manifest_digest: `sha256:${"b".repeat(64)}`, vault_head: "c".repeat(40), vault_tree: "d".repeat(40),
  tombstone_sequence: 0, tombstone_set_root: `sha256:${"e".repeat(64)}` };
function record(text: string, start: number, validity = {
  valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z",
}) {
  const core = { schema_version: 1, sid: "aaaaaaaa", record_text: text,
    record_text_digest: `sha256:${hash(text)}`, citation_span_start: start,
    citation_span_end: start + Buffer.byteLength(text), source_identity_full: hash("shared source"),
    content_identity_full: hash(text), citation_identity_full: hash(`span:${start}`), sensitivity: "personal",
    source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${hash("owner")}`,
    origin_label: "Second Brain", ...validity };
  const digest = hash(`second-brain/memory-record/v1\0${canonicalize(core)}`);
  return { ...core, record_id: `sbrecord:v1:${digest}`, record_digest: `sha256:${digest}` };
}
const records = [record("공통 기억의 첫 번째 결정", 200), record("공통 기억의 두 번째 결정", 400)];
const page = () => ({ kind: "data" as const, value: { ...generation,
  frontmatter: { id: "wiki/shared", title: "Shared", compiled_by: "sb/1.0.0|v1|test", updated: "2026-08-31",
    sources: "", status: "active" }, body: "Two cited statements.", records } });
const reader = (transport: QueuedTransport, checkedAt = now) => createSecondBrainReadAdapter({ transport, contract_profile: "schema4",
  clock: () => checkedAt, max_age_ms: 86_400_000, expiry_ms: 172_800_000,
  budgets: { max_hits: 4, max_excerpt_bytes: 4096, max_page_bytes: 32768, max_total_bytes: 65536 } });

describe("shared-source schema4 memory records", () => {
  it("keeps larger record-set budgets explicit and unavailable to schema3", () => {
    const options = { transport: new QueuedTransport([]), clock: () => now,
      max_age_ms: 86_400_000, expiry_ms: 172_800_000,
      budgets: { max_hits: 4, max_excerpt_bytes: 4096, max_page_bytes: 262144, max_total_bytes: 65537 } };
    expect(() => createSecondBrainReadAdapter({ ...options, contract_profile: "schema4" })).toThrow("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
    expect(() => createSecondBrainReadAdapter({ ...options, contract_profile: "schema3-read-only", budget_profile: "record-set-v1" }))
      .toThrow("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
    expect(() => createSecondBrainReadAdapter({ ...options, contract_profile: "schema4", budget_profile: "record-set-v1",
      budgets: { ...options.budgets, max_total_bytes: 262145 } })).toThrow("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
    expect(() => createSecondBrainReadAdapter({ ...options, contract_profile: "schema4", budget_profile: "record-set-v1",
      budgets: { ...options.budgets, max_page_bytes: 262145 } })).toThrow("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
  });
  it("bounds the cumulative provider and returned evidence cost for all 64 records", async () => {
    const large = () => ({ ...page(), value: { ...page().value, provider_instance_id: "provider:" + "p".repeat(128),
      body: "a".repeat(60 * 64), records: Array.from({ length: 64 }, (_, index) => record("a".repeat(60), 200 + index * 80)) } });
    const read = (total: number) => createSecondBrainReadAdapter({ transport: new QueuedTransport([large()]),
      contract_profile: "schema4", budget_profile: "record-set-v1", clock: () => now,
      max_age_ms: 86_400_000, expiry_ms: 172_800_000,
      budgets: { max_hits: 4, max_excerpt_bytes: 4096, max_page_bytes: 262144, max_total_bytes: total } }).readPage("wiki/shared");
    expect(await read(65536)).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_AGGREGATE_OVERSIZE" });
    let failing = 65536; let passing = 262144;
    while (passing - failing > 1) {
      const middle = Math.floor((passing + failing) / 2);
      if ((await read(middle)).kind === "current") passing = middle; else failing = middle;
    }
    expect(await read(failing)).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_AGGREGATE_OVERSIZE" });
    const result = await read(passing);
    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("expected all bounded records");
    expect(result.evidence).toHaveLength(64);
  });
  it("accepts a new generation in a subsequent read on the same adapter", async () => {
    const next = page();
    next.value.generation_id = `sbgen:v1:${"f".repeat(64)}`;
    next.value.generation_manifest_digest = `sha256:${"9".repeat(64)}`;
    const adapter = reader(new QueuedTransport([page(), next]));
    expect((await adapter.readPage("wiki/shared")).kind).toBe("current");
    expect((await adapter.readPage("wiki/shared")).kind).toBe("current");
  });
  it("still rejects mixed generations inside one search", async () => {
    const next = page();
    next.value.generation_id = `sbgen:v1:${"f".repeat(64)}`;
    const results = records.map(row => ({ page_id: "wiki/shared", section: "", snippet: row.record_text,
      score: 1, record_id: row.record_id, record_digest: row.record_digest }));
    const result = await reader(new QueuedTransport([
      { kind: "data", value: { ...generation, results } }, next,
    ])).search("공통 기억");
    expect(result).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_GENERATION_CHANGED" });
  });
  it("keeps generation metadata on schema4 recent changes", async () => {
    const result = await reader(new QueuedTransport([
      { kind: "data", value: { ...generation, changes: [
        { page_id: "wiki/shared", change: "added", date: "2026-08-31" },
      ] } }, page(),
    ])).recentChanges(1);
    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("expected current evidence");
    expect(result.evidence).toHaveLength(2);
  });
  it("keeps different statements from one citation as separate evidence", async () => {
    const result = await reader(new QueuedTransport([page()])).readPage("wiki/shared");
    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("expected current evidence");
    expect(result.evidence).toHaveLength(2);
    expect(new Set(result.evidence.map(row => row.record?.record_id)).size).toBe(2);
  });
  it("deduplicates repeated records while combining selections from one page", async () => {
    const selections = [...records, ...records.slice(0, 1)].map(row => ({ page_id: "wiki/shared", section: "",
      snippet: row.record_text, score: 1, record_id: row.record_id, record_digest: row.record_digest }));
    const transport = new QueuedTransport([{ kind: "data", value: { ...generation, results: selections } }, page()]);
    const result = await reader(transport).search("공통 기억");
    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("expected current evidence");
    expect(result.evidence).toHaveLength(2);
    expect(transport.calls.filter(call => call.method === "sb_read_page")).toHaveLength(1);
  });
  it("rejects a mismatched selection even when a valid selection follows on the same page", async () => {
    const selections = records.map((row, index) => ({ page_id: "wiki/shared", section: "",
      snippet: row.record_text, score: 1, record_id: row.record_id,
      record_digest: index === 0 ? `sha256:${"f".repeat(64)}` : row.record_digest }));
    const result = await reader(new QueuedTransport([{ kind: "data", value: { ...generation, results: selections } }, page()]))
      .search("공통 기억");
    expect(result).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_RECORD_SELECTION_INVALID" });
  });
});

describe("record validity and bounded read freshness", () => {
  const checkedAt = new Date("2026-11-01T12:00:00.000Z");
  it.each([
    ["unknown start", "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.000Z",
      "current", "2026-11-02T12:00:00.000Z", "2026-11-03T12:00:00.000Z"],
    ["durable historical assertion", "2026-08-31T00:00:00.000Z", "9999-12-31T23:59:59.000Z",
      "current", "2026-11-02T12:00:00.000Z", "2026-11-03T12:00:00.000Z"],
    ["finite current assertion", "2026-08-31T00:00:00.000Z", "2026-11-01T13:00:00.000Z",
      "current", "2026-11-01T13:00:00.000Z", "2026-11-01T13:00:00.000Z"],
    ["exact end boundary", "2026-08-31T00:00:00.000Z", checkedAt.toISOString(),
      "stale", checkedAt.toISOString(), checkedAt.toISOString()],
    ["expired assertion", "2026-08-31T00:00:00.000Z", "2026-09-01T00:00:00.000Z",
      "stale", checkedAt.toISOString(), checkedAt.toISOString()],
    ["future assertion", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z",
      "stale", checkedAt.toISOString(), checkedAt.toISOString()],
  ])("separates %s from response lifetime", async (_label, validFrom, validUntil, kind, freshUntil, expiresAt) => {
    const response = page();
    response.value.records = [record("A dated assertion", 200, { valid_from: validFrom, valid_until: validUntil })];
    const result = await reader(new QueuedTransport([response]), checkedAt).readPage("wiki/shared");
    expect(result.kind).toBe(kind);
    if (result.kind !== "current" && result.kind !== "stale") throw new Error("expected evidence");
    expect(result.evidence[0]).toMatchObject({ valid_at: validFrom, observed_at: checkedAt.toISOString(),
      freshness: { state: kind === "current" ? "fresh" : "stale", fresh_until: freshUntil },
      expires_at: expiresAt, trust: "untrusted", authority: "none" });
  });
  it("still rejects a changed interval without a matching digest", async () => {
    const response = page();
    response.value.records = records.map(row => ({ ...row, valid_until: "9999-12-31T23:59:59.000Z" }));
    const result = await reader(new QueuedTransport([response]), checkedAt).readPage("wiki/shared");
    expect(result).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_RECORD_IDENTITY_INVALID" });
  });
  it.each([
    ["2026-08-31T00:00:00Z", "9999-12-31T23:59:59.000Z"],
    ["2026-08-31T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"],
    ["0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.000Z"],
  ])("rejects an unsupported interval %s to %s even with a matching digest", async (validFrom, validUntil) => {
    const response = page();
    response.value.records = [record("A dated assertion", 200, {
      valid_from: validFrom, valid_until: validUntil,
    })];
    const result = await reader(new QueuedTransport([response]), checkedAt).readPage("wiki/shared");
    expect(result).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_RECORD_IDENTITY_INVALID" });
  });
});
