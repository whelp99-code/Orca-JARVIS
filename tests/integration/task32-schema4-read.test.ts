import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import type { SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";
import type {
  SecondBrainCallOptions,
  SecondBrainMethod,
  SecondBrainOutcome,
  SecondBrainTransport,
} from "../../src/second-brain-transport.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const RECORD_TEXT = "Bound synthetic memory.";
const RECORD_TEXT_DIGEST = `sha256:${createHash("sha256").update(RECORD_TEXT).digest("hex")}`;
const GENERATION = {
  provider_instance_id: "provider:fixture",
  generation_id: `sbgen:v1:${"3".repeat(64)}`,
  generation_manifest_digest: `sha256:${"4".repeat(64)}`,
  vault_head: "5".repeat(40),
  vault_tree: "6".repeat(40),
  tombstone_sequence: 0,
  tombstone_set_root: `sha256:${"7".repeat(64)}`,
} as const;
const RECORD_CORE = {
  schema_version: 1,
  sid: "a8920f4d",
  record_text: RECORD_TEXT,
  record_text_digest: RECORD_TEXT_DIGEST,
  citation_span_start: 10,
  citation_span_end: 33,
  source_identity_full: "8".repeat(64),
  content_identity_full: RECORD_TEXT_DIGEST.slice(7),
  citation_identity_full: "a".repeat(64),
  sensitivity: "personal",
  source_owner_class: "provider_owned",
  source_owner_id_digest: DIGEST,
  origin_label: "Second Brain",
  valid_from: "2026-08-31T00:00:00.000Z",
  valid_until: "2026-09-02T00:00:00.000Z",
} as const;
const RECORD_DIGEST = `sha256:${createHash("sha256")
  .update("second-brain/memory-record/v1\0").update(canonicalize(RECORD_CORE)).digest("hex")}`;
const RECORD_ID = `sbrecord:v1:${RECORD_DIGEST.slice(7)}`;
const RECORD = { ...RECORD_CORE, record_id: RECORD_ID, record_digest: RECORD_DIGEST } as const;

class Schema4Transport implements SecondBrainTransport {
  async call(
    method: SecondBrainMethod,
    _arguments: Readonly<Record<string, unknown>>,
    _options?: SecondBrainCallOptions,
  ): Promise<SecondBrainOutcome> {
    void _arguments;
    void _options;
    switch (method) {
      case "sb_search":
        return { kind: "data", value: { ...GENERATION, results: [{
          page_id: "wiki/example", section: "Intro", snippet: "Bound synthetic memory.",
          score: 1, record_id: RECORD_ID, record_digest: RECORD_DIGEST,
        }] } };
      case "sb_read_page":
        return { kind: "data", value: { ...GENERATION, frontmatter: {
          compiled_by: "sb/0.1.0|v1|fixture", id: "wiki/example", sensitivity: "personal",
          sources: "", status: "active", title: "Example", updated: "2026-08-31",
        }, body: "legacy body is not mutation authority", records: [RECORD] } };
      case "sb_open_conflicts":
        return { kind: "data", value: { ...GENERATION, conflicts: [] } };
      case "sb_recent_changes":
        return { kind: "data", value: { ...GENERATION, changes: [] } };
      case "sb_generation_status":
      case "sb_request_status":
      case "sb_cancellation_status":
      case "sb_submit_cancellation":
      case "sb_resolve_memory_target":
      case "sb_write_request":
        return { kind: "error", code: "NOT_USED" };
      default:
        return assertNever(method);
    }
  }
  restart(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  diagnostics(): readonly [] { return []; }
}

function current(outcome: SecondBrainReadOutcome) {
  expect(outcome.kind).toBe("current");
  if (outcome.kind !== "current") throw new Error("current outcome required");
  return outcome;
}

describe("Task 32 schema-4 consumer", () => {
  it("rejects the schema-3 fixture until the provider-first copy is synced", () => {
    const summary = consumeSecondBrainContract("contracts/second-brain-mcp-v1.json");
    expect(summary.schemaVersion).toBe(4);
    expect(summary.features).toContain("memory_record_identity_v1");
  });

  it("uses bound records rather than legacy body as read authority", async () => {
    // Given
    const adapter = createSecondBrainReadAdapter({ transport: new Schema4Transport(),
      budgets: { max_hits: 20, max_excerpt_bytes: 4_096, max_total_bytes: 65_536,
        max_page_bytes: 65_536 }, clock: () => new Date("2026-09-01T00:00:00.000Z"),
      max_age_ms: 2 * 86_400_000, expiry_ms: 4 * 86_400_000 });
    // When
    const outcome = current(await adapter.search("Bound synthetic memory"));
    // Then
    expect(outcome.evidence).toHaveLength(1);
    expect(outcome.evidence[0]).toMatchObject({ excerpt: RECORD.record_text,
      record: { record_id: RECORD_ID, record_digest: RECORD_DIGEST } });
    expect(JSON.stringify(outcome)).not.toContain("legacy body is not mutation authority");
  });
});

function assertNever(value: never): never {
  throw new Error(`unexpected method: ${String(value)}`);
}
