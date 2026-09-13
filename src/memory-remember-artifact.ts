import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { MemoryExpectedArtifactV2, MemoryObservation } from "./memory-outbox-types.js";
import type { SecondBrainEvidence, SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Match Python str.splitlines/strip, including NEL and excluding BOM from strip.
const pythonWhitespace = String.raw`[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const edges = new RegExp(`^${pythonWhitespace}+|${pythonWhitespace}+$`, "gu");
export function memoryRememberRecordTexts(content: string): readonly string[] {
  // eslint-disable-next-line no-control-regex -- Match the provider's Python splitlines boundaries exactly.
  const texts = content.replaceAll("[^", "\\[\\^").split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)
    .map(line => line.replace(edges, "")).filter(line => line.length > 0);
  if (texts.length === 0 || texts.length > 64 || texts.some(line => Buffer.byteLength(line) > 4_096)) {
    throw new JarvisError("MEMORY_OUTBOX_ARTIFACT_OVERSIZE");
  }
  return texts;
}
/**
 * The identity a remember write carries for the candidate behind it.
 *
 * The provider stores this on every record the write produced, and the resolved target for such a
 * record repeats it - so it is the one number that links a candidate here to a target out there.
 * The content identities on either side are not that link: the provider computes its over the
 * record text and this database computes its own over the candidate material.
 */
export function memoryCandidateSourceIdentity(candidateId: string): string {
  return hash(`memory-candidate:${candidateId}`);
}

export function memoryRememberArtifact(request: Pick<SecondBrainWriteRequestV1, "candidate_id" | "operation" | "payload" | "sensitivity">): {
  readonly artifact: MemoryExpectedArtifactV2;
  readonly record_texts: readonly string[];
  readonly source_identity_full: string;
  readonly sensitivity: string;
} {
  const content = request.payload["content"];
  if (request.operation !== "remember" || typeof content !== "string") throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  const rawHash = hash(content);
  const texts = memoryRememberRecordTexts(content);
  return { artifact: { page_id: `wiki/memory-${hash(`${request.candidate_id}\0${rawHash}`)}`,
    sid: rawHash.slice(0, 8), source_digest: `sha256:${rawHash}` }, record_texts: texts,
  source_identity_full: memoryCandidateSourceIdentity(request.candidate_id), sensitivity: request.sensitivity };
}

export function observeRememberArtifact(
  expected: ReturnType<typeof memoryRememberArtifact>, evidence: readonly SecondBrainEvidence[],
): MemoryObservation {
  const rows = [...evidence].sort((a, b) => (a.record?.citation_span_start ?? -1) - (b.record?.citation_span_start ?? -1));
  const artifact = expected.artifact;
  if (rows.length === 0) return { kind: "missing", code: "ARTIFACT_SELECTOR_MISSING" };
  const conflict = (): MemoryObservation => ({ kind: "conflict", code: "ARTIFACT_DIGEST_MISMATCH",
    page_id: artifact.page_id, sid: artifact.sid });
  if (rows.length !== expected.record_texts.length) return conflict();
  let priorEnd = -1;
  const ids = new Set<string>();
  const generations = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const record = row.record; const text = expected.record_texts[index];
    if (record === null || record.citation_span_start === undefined || record.citation_span_end === undefined) {
      return { kind: "missing", code: "ARTIFACT_RECORD_BINDING_REQUIRED" };
    }
    if (text === undefined || row.page_id !== artifact.page_id || row.sid !== artifact.sid || row.sensitivity !== expected.sensitivity
      || row.content_digest !== `sha256:${hash(text)}` || record.content_identity_full !== hash(text)
      || record.source_identity_full !== expected.source_identity_full || record.source_owner_class !== "provider_owned"
      || !Number.isSafeInteger(record.citation_span_start) || record.citation_span_start < 0
      || !Number.isSafeInteger(record.citation_span_end) || record.citation_span_start < priorEnd
      || record.citation_span_end - record.citation_span_start !== Buffer.byteLength(text)
      || record.citation_identity_full !== hash(`${artifact.page_id}\0${artifact.sid}\0${record.citation_span_start}:${record.citation_span_end}`)
      || ids.has(record.record_id)) return conflict();
    ids.add(record.record_id);
    generations.add(canonicalize(record.generation));
    priorEnd = record.citation_span_end;
  }
  if (generations.size !== 1) return { kind: "missing", code: "MEMORY_GENERATION_CHANGED" };
  return { kind: "match", code: "ARTIFACT_OBSERVED", page_id: artifact.page_id, sid: artifact.sid,
    source_version: rows[0]?.source_version, source_digest: artifact.source_digest };
}
