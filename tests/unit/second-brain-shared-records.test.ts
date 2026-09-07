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
function record(text: string, start: number) {
  const core = { schema_version: 1, sid: "aaaaaaaa", record_text: text,
    record_text_digest: `sha256:${hash(text)}`, citation_span_start: start,
    citation_span_end: start + Buffer.byteLength(text), source_identity_full: hash("shared source"),
    content_identity_full: hash(text), citation_identity_full: hash(`span:${start}`), sensitivity: "personal",
    source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${hash("owner")}`,
    origin_label: "Second Brain", valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" };
  const digest = hash(`second-brain/memory-record/v1\0${canonicalize(core)}`);
  return { ...core, record_id: `sbrecord:v1:${digest}`, record_digest: `sha256:${digest}` };
}
const records = [record("공통 기억의 첫 번째 결정", 200), record("공통 기억의 두 번째 결정", 400)];
const page = () => ({ kind: "data" as const, value: { ...generation,
  frontmatter: { id: "wiki/shared", title: "Shared", compiled_by: "sb/1.0.0|v1|test", updated: "2026-08-31",
    sources: "", status: "active" }, body: "Two cited statements.", records } });
const reader = (transport: QueuedTransport) => createSecondBrainReadAdapter({ transport, contract_profile: "schema4",
  clock: () => now, max_age_ms: 86_400_000, expiry_ms: 172_800_000,
  budgets: { max_hits: 4, max_excerpt_bytes: 4096, max_page_bytes: 32768, max_total_bytes: 65536 } });

describe("shared-source schema4 memory records", () => {
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
