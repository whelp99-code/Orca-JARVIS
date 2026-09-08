import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: false, precision: 3 });
const nullableDigest = digest.nullable();
export const MemoryDispositionProofSchema = z.object({
  schema_version: z.literal(1),
  proof_id: z.string().regex(/^sbproof:v1:[0-9a-f]{64}$/),
  proof_digest: digest,
  proof_type: z.enum(["correction", "forget", "export"]),
  provider_instance_id: z.string().min(1).max(128),
  provider_release_sha: z.string().regex(/^[0-9a-f]{40}$/),
  provider_signing_key_id: z.string().min(1).max(128),
  request_id: z.string().regex(/^memeff:req:v2:[0-9a-f]{64}$/),
  request_digest: digest,
  envelope_digest: digest,
  idempotency_key: z.string().regex(/^memeff:idem:v2:[0-9a-f]{64}$/),
  delegation_id: z.string().regex(/^memdeleg:v1:[0-9a-f]{64}$/),
  delegation_digest: digest,
  lane_id: z.string().min(1).max(160),
  operation: z.enum(["correct", "forget", "export"]),
  payload_digest: digest,
  target_manifest_digest: digest,
  scope_digest: digest,
  base_generation_id: z.string().min(1).max(160),
  base_head: z.string().regex(/^[0-9a-f]{40}$/),
  base_tree: z.string().regex(/^[0-9a-f]{40}$/),
  result_generation_id: z.string().min(1).max(160),
  result_head: z.string().regex(/^[0-9a-f]{40}$/),
  result_tree: z.string().regex(/^[0-9a-f]{40}$/),
  tombstone_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tombstone_previous_root: digest,
  tombstone_set_root: digest,
  activation_journal_digest: nullableDigest,
  reader_drain_digest: nullableDigest,
  predecessor_disposal_digest: nullableDigest,
  backup_disposal_digest: nullableDigest,
  export_disposal_digest: nullableDigest,
  surface_manifest_digest: digest,
  artifact_manifest_digest: nullableDigest,
  export_manifest_digest: nullableDigest,
  claimed_at: instant,
  applied_at: instant,
  completed_at: instant,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type MemoryDispositionProofV1 = z.infer<typeof MemoryDispositionProofSchema>;

export type MemoryProofExpectation = {
  readonly provider_instance_id: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly envelope_digest: string;
  readonly idempotency_key: string;
  readonly delegation_id: string;
  readonly delegation_digest: string;
  readonly lane_id: string;
  readonly operation: "correct" | "forget" | "export";
  readonly payload_digest: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
};

function proofDigest(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256")
    .update("second-brain/memory-disposition-proof/v1\0")
    .update(canonicalize(value)).digest("hex")}`;
}

export function verifyMemoryDispositionProof(
  authority: AuthorityDb,
  value: unknown,
  expected: MemoryProofExpectation,
  now: Date,
): MemoryDispositionProofV1 {
  const parsed = MemoryDispositionProofSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  const proof = parsed.data;
  const expectedType = expected.operation === "correct" ? "correction" : expected.operation;
  if (proof.proof_type !== expectedType
    || proof.provider_instance_id !== expected.provider_instance_id
    || proof.request_id !== expected.request_id
    || proof.request_digest !== expected.request_digest
    || proof.envelope_digest !== expected.envelope_digest
    || proof.idempotency_key !== expected.idempotency_key
    || proof.delegation_id !== expected.delegation_id
    || proof.delegation_digest !== expected.delegation_digest
    || proof.lane_id !== expected.lane_id
    || proof.operation !== expected.operation
    || proof.payload_digest !== expected.payload_digest
    || proof.target_manifest_digest !== expected.target_manifest_digest
    || proof.scope_digest !== expected.scope_digest
    || proof.tombstone_sequence !== expected.tombstone_sequence
    || proof.tombstone_set_root !== expected.tombstone_set_root) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_BINDING_INVALID");
  }
  const complete = { ...proof } as Record<string, unknown>;
  const unsignedDigest = Object.fromEntries(Object.entries(complete)
    .filter(([name]) => !["proof_id", "proof_digest", "signature"].includes(name)));
  const observed = proofDigest(unsignedDigest);
  if (proof.proof_digest !== observed || proof.proof_id !== `sbproof:v1:${observed.slice(7)}`) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_DIGEST_INVALID");
  }
  const key = authority.db.prepare(
    `SELECT public_key_pem FROM memory_provider_proof_keys
     WHERE key_id=? AND provider_instance_id=? AND provider_release_sha=? AND state='active'
       AND valid_from<=? AND valid_until>?
       AND valid_from<=? AND valid_until>?`,
  ).get(proof.provider_signing_key_id, proof.provider_instance_id,
    proof.provider_release_sha, now.toISOString(), now.toISOString(),
    proof.completed_at, proof.completed_at) as
    { readonly public_key_pem: string } | undefined;
  if (key === undefined) throw new JarvisError("MEMORY_PROVIDER_PROOF_KEY_INVALID");
  const signed = Object.fromEntries(Object.entries(complete).filter(([name]) => name !== "signature"));
  const valid = verify(null,
    Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(signed)}`),
    createPublicKey(key.public_key_pem), Buffer.from(proof.signature, "base64url"));
  if (!valid) throw new JarvisError("MEMORY_PROVIDER_PROOF_SIGNATURE_INVALID");
  const claimed = Date.parse(proof.claimed_at);
  const applied = Date.parse(proof.applied_at);
  const completed = Date.parse(proof.completed_at);
  if (!(claimed <= applied && applied <= completed && completed <= now.getTime())) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_TIME_INVALID");
  }
  if (proof.operation === "export") {
    if (proof.export_manifest_digest === null || proof.activation_journal_digest !== null
      || proof.base_generation_id !== proof.result_generation_id
      || proof.base_head !== proof.result_head || proof.base_tree !== proof.result_tree) {
      throw new JarvisError("MEMORY_PROVIDER_PROOF_OPERATION_INVALID");
    }
  } else if (proof.activation_journal_digest === null || proof.reader_drain_digest === null
    || proof.predecessor_disposal_digest === null || proof.backup_disposal_digest === null
    || proof.export_disposal_digest === null || proof.export_manifest_digest !== null
    || (proof.operation === "correct" && proof.artifact_manifest_digest === null)) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_OPERATION_INVALID");
  }
  return Object.freeze(proof);
}
