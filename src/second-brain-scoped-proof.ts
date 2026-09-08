import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import { secondBrainGenerationBinding } from "./second-brain-generation-read.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";

const fail = (): never => { throw new JarvisError("SECOND_BRAIN_SCOPED_PROOF_INVALID"); };
function object(value: unknown, keys: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(" ") !== keys) return fail();
  return { ...value };
}
/** Correlate historical provider proof with the acceptance and an independently
 * read, trusted generation binding. Hashes do not authenticate their sender.
 * Generation identity alone does not attest source access classifications.
 * Scoped artifact access evidence is also required before settlement.
 * This does not settle an outbox or authorize access to remembered content. */
export function verifySecondBrainScopedProof(request: MemoryScopedWriteRequestMaterial, acceptance: unknown,
  proofValue: unknown, receiptValue: unknown, observedGeneration: unknown, observedAt: Date) {
  const accepted = parseSecondBrainScopedWriteAccepted(acceptance, request, observedAt);
  const proof = object(proofValue, "content_digest generation_id head provider_instance_id request_digest request_id schema_version scope_digest tree");
  const receipt = object(receiptValue, "code envelope_digest proof_digest request_digest request_id schema_version state status_digest updated_at");
  const generation = secondBrainGenerationBinding({ __generation_binding: observedGeneration });
  const updated = typeof receipt.updated_at === "string" ? Date.parse(receipt.updated_at) : NaN;
  if (generation === undefined || generation.tombstone_sequence < 0
    || generation.generation_id !== `sbgen:v1:${generation.generation_manifest_digest.slice(7)}`
    || proof.schema_version !== 4 || receipt.schema_version !== 4
    || proof.provider_instance_id !== accepted.provider_instance_id || generation.provider_instance_id !== accepted.provider_instance_id
    || proof.request_id !== accepted.request_id || receipt.request_id !== accepted.request_id
    || proof.request_digest !== accepted.request_digest || receipt.request_digest !== accepted.request_digest
    || proof.scope_digest !== accepted.scope_digest || proof.generation_id !== generation.generation_id
    || proof.head !== generation.vault_head || proof.tree !== generation.vault_tree
    || proof.content_digest !== `sha256:${createHash("sha256").update(request.preparation.payload.content, "utf8").digest("hex")}`
    || receipt.state !== "proved" || receipt.code !== "PROVIDER_PROVED" || receipt.envelope_digest !== null
    || !Number.isFinite(updated) || new Date(updated).toISOString() !== receipt.updated_at
    || updated < Date.parse(accepted.accepted_at) || updated > observedAt.getTime()) return fail();
  const proofDigest = memoryHash("second-brain/memory-surface-manifest/v1\0", proof);
  if (receipt.proof_digest !== proofDigest || receipt.status_digest !== memoryHash("second-brain/memory-surface-manifest/v1\0",
    { state: "proved", proof: proofDigest })) return fail();
  return Object.freeze({ kind: "proof_consistent" as const, proof: Object.freeze(proof),
    receipt: Object.freeze(receipt), generation: Object.freeze(generation) });
}
