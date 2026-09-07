import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryRememberArtifact, observeRememberArtifact } from "../../src/memory-remember-artifact.js";
import type { SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";
import { evidence } from "../fixtures/memory-outbox-fixture.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const candidate = `memcand:pos:v1:${"1".repeat(64)}`;
const request = (content: string) => ({ candidate_id: candidate, operation: "remember" as const,
  payload: { content }, sensitivity: "personal" as const });
const plan = memoryRememberArtifact(request("첫 줄\u2028  반복  \u0085\u0085반복\u2029사용자 [^deadbeef]"));
const generation = { provider_instance_id: "provider:test", generation_id: "generation:test",
  generation_manifest_digest: `sha256:${"2".repeat(64)}`, vault_head: "3".repeat(40), vault_tree: "4".repeat(40),
  tombstone_sequence: 0, tombstone_set_root: `sha256:${"5".repeat(64)}` };
function rows(): SecondBrainEvidence[] {
  const texts = ["첫 줄", "반복", "반복", "사용자 \\[\\^deadbeef]"];
  return texts.map((text, index) => {
    const start = 200 + index * 100; const end = start + Buffer.byteLength(text);
    return { ...evidence(`sha256:${hash(text)}`, plan.artifact.sid), page_id: plan.artifact.page_id, excerpt: text,
      record: { record_id: `sbrecord:v1:${hash(String(index))}`, record_digest: `sha256:${hash(String(index))}`,
        source_identity_full: hash(`memory-candidate:${candidate}`), content_identity_full: hash(text),
        citation_identity_full: hash(`${plan.artifact.page_id}\0${plan.artifact.sid}\0${start}:${end}`),
        citation_span_start: start, citation_span_end: end, source_owner_class: "provider_owned",
        source_owner_id_digest: `sha256:${"6".repeat(64)}`, origin_label: "Second Brain", generation } };
  });
}
describe("complete remember artifact observation", () => {
  it("matches every escaped record by citation position despite consumer sorting", () => {
    expect(plan.record_texts).toEqual(["첫 줄", "반복", "반복", "사용자 \\[\\^deadbeef]"]);
    expect(observeRememberArtifact(plan, rows().reverse())).toMatchObject({ kind: "match", source_digest: plan.artifact.source_digest });
  });
  it("rejects missing, extra, duplicate, re-ordered and foreign-origin records", () => {
    const input = rows(); const first = input[0]; const second = input[1];
    if (!first?.record || !second?.record) throw new Error("missing fixture binding");
    const reordered = [...input];
    reordered[0] = { ...first, content_digest: second.content_digest, record: { ...first.record, content_identity_full: second.record.content_identity_full } };
    for (const changed of [input.slice(1), [...input, first], [first, first, ...input.slice(2)], reordered,
      [{ ...first, sid: "different" }, ...input.slice(1)],
      [{ ...first, record: { ...first.record, source_identity_full: "9".repeat(64) } }, ...input.slice(1)]]) {
      expect(observeRememberArtifact(plan, changed).kind).toBe("conflict");
    }
  });
  it("uses full record digests for redacted results and refuses mixed generations", () => {
    expect(observeRememberArtifact(plan, rows().map(row => ({ ...row, excerpt: null, omission: "policy_redacted" }))).kind).toBe("match");
    const input = rows(); const first = input[0];
    if (!first?.record) throw new Error("missing fixture binding");
    input[0] = { ...first, record: { ...first.record, generation: { ...generation, generation_id: "other" } } };
    expect(observeRememberArtifact(plan, input)).toMatchObject({ kind: "missing", code: "MEMORY_GENERATION_CHANGED" });
  });
  it("preserves Python BOM semantics and bounds record count and escaped bytes", () => {
    expect(memoryRememberArtifact(request("a\u2028\ufeffb")).record_texts).toEqual(["a", "\ufeffb"]);
    expect(memoryRememberArtifact(request(Array(64).fill("a").join("\u2028"))).record_texts).toHaveLength(64);
    expect(() => memoryRememberArtifact(request(Array(65).fill("a").join("\u2028")))).toThrow("MEMORY_OUTBOX_ARTIFACT_OVERSIZE");
    expect(() => memoryRememberArtifact(request("[^x]".repeat(800)))).toThrow("MEMORY_OUTBOX_ARTIFACT_OVERSIZE");
  });
});
