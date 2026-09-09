import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifySecondBrainScopedProof } from "../../src/second-brain-scoped-proof.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
const request = JSON.parse(readFileSync(new URL('../fixtures/scoped-write-request-v4.json', import.meta.url), 'utf8'));
const evidence = JSON.parse(readFileSync(new URL('../fixtures/scoped-provider-proof-v4.json', import.meta.url), 'utf8'));
const generation = { provider_instance_id: evidence.proof.provider_instance_id, generation_id: evidence.proof.generation_id,
  generation_manifest_digest: `sha256:${evidence.proof.generation_id.slice(9)}`, vault_head: evidence.proof.head,
  vault_tree: evidence.proof.tree, tombstone_sequence: 0, tombstone_set_root: `sha256:${'0'.repeat(64)}` };
const at = new Date(Date.parse(request.expires_at) + 60000);
it("verifies actual Python-produced evidence after request expiry without renewing authority", () => {
  const result = verifySecondBrainScopedProof(request, evidence.accepted, evidence.proof, evidence.receipt, generation, at);
  expect(result.kind).toBe("proof_consistent");
  expect(Object.isFrozen(result.proof)).toBe(true);
  expect(result.proof).not.toBe(evidence.proof);
});
it.each(["request", "scope", "provider", "content", "head", "tree", "generation", "extra", "version"])(
  "rejects %s proof substitutions even with recomputed proof and status hashes", mode => {
    const proof = { ...evidence.proof };
    const mapping: Record<string, string> = { request: "request_id", scope: "scope_digest", provider: "provider_instance_id",
      content: "content_digest", head: "head", tree: "tree", generation: "generation_id" };
    if (mode === "extra") proof.extra = true;
    else if (mode === "version") proof.schema_version = 3;
    else proof[mapping[mode]!] = 'changed';
    const digest = memoryHash('second-brain/memory-surface-manifest/v1\0', proof);
    const receipt = { ...evidence.receipt, proof_digest: digest,
      status_digest: memoryHash('second-brain/memory-surface-manifest/v1\0', { state: 'proved', proof: digest }) };
    expect(() => verifySecondBrainScopedProof(request, evidence.accepted, proof, receipt, generation, at)).toThrow();
  });
it.each([{ state: "pending" }, { code: "FAILED" }, { proof_digest: "changed" }, { status_digest: "changed" },
  { envelope_digest: "changed" }, { updated_at: "2020-01-01T00:00:00.000Z" }, { updated_at: "2099-01-01T00:00:00.000Z" },
  { request_digest: "changed" }, { extra: true }])("rejects invalid receipt %j", change => {
  expect(() => verifySecondBrainScopedProof(request, evidence.accepted, evidence.proof, { ...evidence.receipt, ...change }, generation, at)).toThrow();
});
it.each([{ vault_head: "a".repeat(40) }, { generation_manifest_digest: `sha256:${"0".repeat(64)}` },
  { provider_instance_id: "provider:other" }, { tombstone_sequence: -1 }])("rejects mismatched independent generation %j", change => {
  expect(() => verifySecondBrainScopedProof(request, evidence.accepted, evidence.proof, evidence.receipt, { ...generation, ...change }, at)).toThrow();
});
