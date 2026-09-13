import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2.js";
import type { SecondBrainMethod, SecondBrainOutcome, SecondBrainTransport } from "../../src/second-brain-transport.js";

export const REFERENCE_NOW = new Date("2026-08-31T03:30:00.000Z");
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const REFERENCE_GENERATION = { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"1".repeat(64)}`,
  generation_manifest_digest: digest("manifest"), vault_head: "2".repeat(40), vault_tree: "3".repeat(40),
  tombstone_sequence: 0, tombstone_set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
const text = "공통 기억\r\n\r\n둘째\t내용\r셋째\n";
const core = { schema_version: 1, sid: "12345678", record_text: text, record_text_digest: digest(text),
  citation_span_start: 0, citation_span_end: Buffer.byteLength(text), source_identity_full: "4".repeat(64),
  content_identity_full: digest(text).slice(7), citation_identity_full: "5".repeat(64), sensitivity: "personal",
  source_owner_class: "provider_owned", source_owner_id_digest: digest("owner"), origin_label: "fixture:source",
  valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" };
const recordDigest = digest(`second-brain/memory-record/v1\0${canonicalize(core)}`);
export const REFERENCE_RECORD = { ...core, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest };

/**
 * The target identity the provider resolves for that one record.
 *
 * Every field is computed here from the record itself and the digest binds all of them, which is
 * what lets the product verify the answer instead of believing it.
 */
export const REFERENCE_TARGET = (() => {
  const core = { schema_version: 1,
    provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
    generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest,
    vault_head: REFERENCE_GENERATION.vault_head, vault_tree: REFERENCE_GENERATION.vault_tree,
    page_id: "wiki/reference", page_blob_oid: "7".repeat(40), page_content_digest: digest("page"),
    source_identity_full: REFERENCE_RECORD.source_identity_full,
    content_identity_full: REFERENCE_RECORD.content_identity_full,
    citation_identity_full: REFERENCE_RECORD.citation_identity_full,
    citation_span_start: REFERENCE_RECORD.citation_span_start,
    citation_span_end: REFERENCE_RECORD.citation_span_end,
    subject_digest: digest("subject"), sensitivity: REFERENCE_RECORD.sensitivity,
    valid_from: REFERENCE_RECORD.valid_from, valid_until: REFERENCE_RECORD.valid_until,
    source_owner_class: REFERENCE_RECORD.source_owner_class,
    source_owner_id_digest: REFERENCE_RECORD.source_owner_id_digest,
    resolved_at: "2026-08-28T00:00:00.000Z", expires_at: "2126-09-01T00:00:00.000Z" };
  const targetDigest = digest(`second-brain/memory-target/v1\u0000${canonicalize(core)}`);
  return { ...core, target_id: `sbtarget:v1:${targetDigest.slice(7)}`, target_digest: targetDigest };
})();

export class MemoryReferenceProvider implements SecondBrainTransport {
  readonly calls: Array<{ method: SecondBrainMethod; args: Readonly<Record<string, unknown>> }> = [];
  statuses = 0;
  closed = false;
  empty = false;
  onCall?: (method: SecondBrainMethod) => void | Promise<void>;
  statusOverrides: Readonly<Record<string, unknown>> = {};
  async call(method: SecondBrainMethod, args: Readonly<Record<string, unknown>>): Promise<SecondBrainOutcome> {
    this.calls.push({ method, args });
    if (method === "sb_generation_status") this.statuses++;
    await this.onCall?.(method);
    if (method === "sb_generation_status") return { kind: "data", value: { schema_version: 1,
      ...REFERENCE_GENERATION, pointer_health: "healthy", journal_health: "healthy", ...this.statusOverrides } };
    if (method === "sb_search") return { kind: "data", value: { ...REFERENCE_GENERATION, results: this.empty ? [] : [{
      page_id: "wiki/reference", section: "Memory", snippet: text, score: 1,
      record_id: REFERENCE_RECORD.record_id, record_digest: REFERENCE_RECORD.record_digest }] } };
    if (method === "sb_read_page") return { kind: "data", value: { ...REFERENCE_GENERATION,
      frontmatter: { id: "wiki/reference", title: "Reference", updated: "2026-08-31", compiled_by: "sb/fixture",
        sensitivity: "personal", status: "active", sources: "" }, body: "legacy body is not evidence", records: [REFERENCE_RECORD] } };
    if (method === "sb_resolve_memory_target") return { kind: "data", value: REFERENCE_TARGET };
    throw new Error(`unexpected method ${method}`);
  }
  async restart(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; }
  diagnostics(): readonly [] { return []; }
}
