import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";
import type { parseScopedSecondBrainResponse } from "./second-brain-scoped-read.js";

const fail = (): never => { throw new JarvisError("SECOND_BRAIN_REMEMBERED_ARTIFACT_INVALID"); };
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** Snapshot historical input before asynchronous transport. This grants no write
 * authority, and does not attest the exact stored classification or completion. */
export function rememberedArtifactExpectation(request: MemoryScopedWriteRequestMaterial, acceptance: unknown, at: Date) {
  const accepted = parseSecondBrainScopedWriteAccepted(acceptance, request, at);
  const snapshot = parseMemoryScopedWriteRequestJson(canonicalize(request), request.provider_instance_id, new Date(accepted.accepted_at));
  const identity = snapshot.preparation.binding.identity;
  const content = snapshot.preparation.payload.content;
  const contentHash = hash(content);
  // Python splitlines/strip for the accepted plain-text-v1 alphabet. U+FEFF
  // is not Python whitespace and must not be stripped by JavaScript trim().
  function strip(line: string): string {
    const whitespace = (code: number) => (code >= 9 && code <= 13) || (code >= 28 && code <= 32)
      || [133, 160, 5760, 8232, 8233, 8239, 8287, 12288].includes(code) || (code >= 8192 && code <= 8202);
    let start = 0; let end = line.length;
    while (start < end && whitespace(line.charCodeAt(start))) start++;
    while (end > start && whitespace(line.charCodeAt(end - 1))) end--;
    return line.slice(start, end);
  }
  const lines = content.replaceAll("[^", "\\[\\^").split(/\r\n|[\n\r\u0085\u2028\u2029]/).map(strip).filter(Boolean);
  return Object.freeze({ request_id: snapshot.request_id, request_digest: snapshot.request_digest,
    provider: snapshot.provider_instance_id, owner: identity.owner, projects: Object.freeze([...identity.projects]),
    policy: identity.policy_revision, page_id: `wiki/memory-${hash(`${identity.candidate_id}\0${contentHash}`)}`,
    source_ref_digest: "sha256:" + hash("second-brain/source-access-identity/v1\0" + canonicalize(["memory-candidate", identity.candidate_id, contentHash])),
    source: hash(`memory-candidate:${identity.candidate_id}`), sid: contentHash.slice(0, 8),
    sensitivity: snapshot.preparation.payload.sensitivity, lines: Object.freeze(lines) });
}

export function verifyRememberedArtifactRead(expected: ReturnType<typeof rememberedArtifactExpectation>,
  response: ReturnType<typeof parseScopedSecondBrainResponse>) {
  const generation = response.generation;
  const page = response.pages[0];
  if (generation.provider_instance_id !== expected.provider
    || generation.generation_id !== `sbgen:v1:${generation.generation_manifest_digest.slice(7)}`
    || response.pages.length !== 1 || page?.page_id !== expected.page_id || page.parsed.kind !== "current") return fail();
  const evidence = [...page.parsed.evidence].sort((a, b) => (a.record?.citation_span_start ?? -1) - (b.record?.citation_span_start ?? -1));
  if (evidence.length !== expected.lines.length || !evidence.length) return fail();
  let previousEnd = -1;
  for (const [index, row] of evidence.entries()) {
    const record = row.record;
    const text = expected.lines[index]!;
    const redacted = expected.sensitivity === "sensitive" || expected.sensitivity === "restricted";
    if (row.content_digest !== `sha256:${hash(text)}`
      || (redacted ? row.excerpt !== null || row.omission !== "policy_redacted" : row.excerpt !== text || row.omission !== null)
      || row.sid !== expected.sid
      || row.sensitivity !== expected.sensitivity || record === null || record.source_identity_full !== expected.source
      || record.source_owner_class !== "provider_owned" || record.citation_span_start === undefined
      || record.citation_span_end === undefined || record.citation_span_start < previousEnd) return fail();
    previousEnd = record.citation_span_end;
  }
  if (page.access !== undefined) {
    const source = page.access.sources[0];
    if (page.access.sources.length !== 1 || source?.source_ref_digest !== expected.source_ref_digest
      || source.classification.owner !== expected.owner || source.classification.policy_revision !== expected.policy
      || canonicalize(source.classification.projects) !== canonicalize(expected.projects)) return fail();
  }
  return Object.freeze({ kind: page.access === undefined ? "remembered_content_observed" as const : "remembered_artifact_observed" as const,
    ...(page.access === undefined ? {} : { access: page.access }), request_id: expected.request_id,
    request_digest: expected.request_digest, page_id: expected.page_id, content_digest: page.content_digest,
    generation: Object.freeze({ ...generation }), record_ids: Object.freeze(evidence.map(row => row.record!.record_id)) });
}
