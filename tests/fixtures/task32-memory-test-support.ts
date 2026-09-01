import type { SecondBrainEvidence, SecondBrainReadAdapter,
  SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";

export const TASK32_NOW = new Date("2026-09-01T00:00:00.000Z");

type EvidenceOptions = { readonly suffix?: string; readonly sensitivity?: "personal" | "restricted";
  readonly excerpt?: string | null; readonly tombstoneSequence?: number };
export function task32Evidence(options: EvidenceOptions = {}): SecondBrainEvidence {
  const suffix = options.suffix ?? "1";
  const sensitivity = options.sensitivity ?? "personal";
  const excerpt = options.excerpt === undefined ? "Synthetic Task 32 record" : options.excerpt;
  return { kind: "memory", page_id: `wiki/task32-${suffix}`, sid: `1234567${suffix}`,
    source_ref: sensitivity === "restricted" ? "Private source" : "Second Brain",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|task32",
    sensitivity, observed_at: TASK32_NOW.toISOString(), valid_at: TASK32_NOW.toISOString(),
    freshness: { state: "fresh", checked_at: TASK32_NOW.toISOString(),
      fresh_until: "2026-09-01T01:00:00.000Z" }, expires_at: "2026-09-02T00:00:00.000Z",
    trust: "untrusted", authority: "none", excerpt,
    content_digest: `sha256:${suffix.repeat(64)}`,
    omission: sensitivity === "restricted" ? "policy_redacted" : null,
    record: { record_id: `sbrecord:v1:${suffix.repeat(64)}`,
      record_digest: `sha256:${suffix.repeat(64)}`, source_identity_full: "a".repeat(64),
      content_identity_full: "b".repeat(64), citation_identity_full: "c".repeat(64),
      source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${"d".repeat(64)}`,
      origin_label: "Second Brain", generation: { provider_instance_id: "provider:task32",
        generation_id: `sbgen:v1:${"e".repeat(64)}`,
        generation_manifest_digest: `sha256:${"f".repeat(64)}`, vault_head: "1".repeat(40),
        vault_tree: "2".repeat(40), tombstone_sequence: options.tombstoneSequence ?? 0,
        tombstone_set_root: `sha256:${"3".repeat(64)}` } } };
}

export class Task32ReadAdapter implements SecondBrainReadAdapter {
  readonly contract_profile = "schema4" as const;
  constructor(readonly records: readonly SecondBrainEvidence[] = [task32Evidence()]) {}
  search(): Promise<SecondBrainReadOutcome> { return Promise.resolve({ kind: "current",
    checked_at: TASK32_NOW.toISOString(), evidence: this.records }); }
  readPage(pageId: string): Promise<SecondBrainReadOutcome> { return Promise.resolve({ kind: "current",
    checked_at: TASK32_NOW.toISOString(), evidence: this.records.filter(item => item.page_id === pageId) }); }
  recentChanges(): Promise<SecondBrainReadOutcome> { return this.search(); }
  openConflicts(): Promise<SecondBrainReadOutcome> { return Promise.resolve({ kind: "conflicts",
    checked_at: TASK32_NOW.toISOString(), conflicts: [] }); }
}
