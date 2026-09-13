import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2.js";
import type { SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = (value: string): string => `sha256:${hex(value)}`;

/** One generation for every record a settlement fixture serves; the observer requires exactly one. */
export const REMEMBER_GENERATION = {
  provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"1".repeat(64)}`,
  generation_manifest_digest: digest("manifest"), vault_head: "2".repeat(40),
  vault_tree: "3".repeat(40), tombstone_sequence: 0, tombstone_set_root: MEMORY_TOMBSTONE_GENESIS_ROOT,
} as const;

export type RememberArtifactFixture = {
  readonly page_id: string;
  readonly sid: string;
  readonly source_digest: string;
  readonly evidence: readonly SecondBrainEvidence[];
};

/**
 * The destination a remember write derives, and the records a provider would show once it landed.
 *
 * The product decides where a remembered statement goes - page and section both come from the
 * candidate and the content, not from whoever is writing the test - so this asks it, and then builds
 * the evidence that destination would actually carry. Every field the settlement observer checks is
 * computed the way it computes it: one record per line of the statement, contiguous citation spans,
 * content identity over the line, citation identity over page, section and span, and the source
 * identity of the candidate behind the write.
 */
export function rememberArtifact(options: {
  readonly candidate_id: string; readonly statement: string; readonly sensitivity: string;
  readonly observed_at: string; readonly fresh_until: string; readonly expires_at: string;
  readonly valid_until?: string;
}): RememberArtifactFixture {
  const expected = memoryRememberArtifact({ candidate_id: options.candidate_id, operation: "remember",
    payload: { content: options.statement }, sensitivity: options.sensitivity } as never);
  const artifact = expected.artifact;
  let start = 0;
  const evidence = expected.record_texts.map(text => {
    const end = start + Buffer.byteLength(text);
    const core = {
      schema_version: 1, sid: artifact.sid, record_text: text, record_text_digest: digest(text),
      citation_span_start: start, citation_span_end: end,
      source_identity_full: expected.source_identity_full, content_identity_full: hex(text),
      citation_identity_full: hex(`${artifact.page_id}\u0000${artifact.sid}\u0000${start}:${end}`),
      sensitivity: expected.sensitivity, source_owner_class: "provider_owned",
      source_owner_id_digest: digest("owner"), origin_label: "Second Brain",
      valid_from: options.observed_at, valid_until: options.valid_until ?? "2126-09-01T00:00:00.000Z",
    };
    const recordDigest = `sha256:${createHash("sha256").update("second-brain/memory-record/v1\u0000")
      .update(canonicalize(core)).digest("hex")}`;
    start = end;
    return {
      kind: "memory", page_id: artifact.page_id, sid: artifact.sid,
      source_ref: `memory-candidate:${options.candidate_id}`,
      source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|fixture",
      sensitivity: expected.sensitivity, observed_at: options.observed_at, valid_at: options.observed_at,
      freshness: { state: "fresh", checked_at: options.observed_at, fresh_until: options.fresh_until },
      expires_at: options.expires_at, trust: "untrusted", authority: "none", excerpt: text,
      content_digest: digest(text), omission: null,
      record: { ...core, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest,
        generation: REMEMBER_GENERATION },
    } as unknown as SecondBrainEvidence;
  });
  return { page_id: artifact.page_id, sid: artifact.sid, source_digest: artifact.source_digest, evidence };
}
