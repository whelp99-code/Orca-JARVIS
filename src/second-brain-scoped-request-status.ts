import { canonicalize } from "./canonical.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";

const fail = (): never => { throw new JarvisError("SECOND_BRAIN_SCOPED_STATUS_INVALID"); };
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  return { ...value };
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(" ") !== [...keys].sort().join(" ")) return fail();
}
/** Called only after authenticated scoped response/fence checks. This validates
 * historical journal evidence, not current artifact visibility or final settlement. */
export function parseSecondBrainScopedRequestStatus(value: unknown, request: MemoryScopedWriteRequestMaterial,
  acceptance: unknown, at: Date): Readonly<Record<string, unknown>> {
  const accepted = parseSecondBrainScopedWriteAccepted(acceptance, request, at);
  const status = object(value);
  const base = ["schema_version", "provider_instance_id", "request_id", "request_digest", "scope_digest", "state"];
  if (status.schema_version !== 4 || status.provider_instance_id !== accepted.provider_instance_id
    || status.request_id !== accepted.request_id || status.request_digest !== accepted.request_digest
    || status.scope_digest !== accepted.scope_digest) return fail();
  if (status.state === "not_found") { exact(status, base); return Object.freeze(status); }
  if (!["pending", "processing", "proved", "failed", "expired", "reapproval_required"].includes(String(status.state))) return fail();
  const updated = typeof status.updated_at === "string" ? Date.parse(status.updated_at) : NaN;
  if (!Number.isFinite(updated) || new Date(updated).toISOString() !== status.updated_at
    || updated < Date.parse(accepted.accepted_at) || updated > at.getTime()
    || (status.phase !== null && !["claimed", "staging", "sealed", "switch_intent", "activated", "disposing",
      "proved"].includes(String(status.phase)))) return fail();
  exact(status, [...base, "phase", "updated_at", ...(status.state === "proved" ? ["proof", "receipt"] : [])]);
  if (status.state !== "proved") return Object.freeze(status);
  const proof = object(status.proof), receipt = object(status.receipt);
  exact(proof, ["schema_version", "provider_instance_id", "request_id", "request_digest", "scope_digest", "content_digest", "generation_id", "head", "tree"]);
  exact(receipt, ["schema_version", "request_id", "request_digest", "envelope_digest", "state", "code", "proof_digest", "status_digest", "updated_at"]);
  if (status.phase !== "proved" || proof.schema_version !== 4 || receipt.schema_version !== 4
    || proof.provider_instance_id !== accepted.provider_instance_id
    || proof.request_id !== accepted.request_id || receipt.request_id !== accepted.request_id
    || proof.request_digest !== accepted.request_digest || receipt.request_digest !== accepted.request_digest
    || proof.scope_digest !== accepted.scope_digest
    || proof.content_digest !== "sha256:" + createHash("sha256").update(request.preparation.payload.content, "utf8").digest("hex")
    || !/^sbgen:v1:[0-9a-f]{64}$/.test(String(proof.generation_id))
    || !/^[0-9a-f]{40}$/.test(String(proof.head)) || !/^[0-9a-f]{40}$/.test(String(proof.tree))
    || receipt.envelope_digest !== null || receipt.state !== "proved" || receipt.code !== "PROVIDER_PROVED"
    || receipt.updated_at !== status.updated_at) return fail();
  const proofDigest = memoryHash("second-brain/memory-surface-manifest/v1\0", proof);
  if (receipt.proof_digest !== proofDigest || receipt.status_digest !== memoryHash("second-brain/memory-surface-manifest/v1\0", { state: "proved",
    proof: proofDigest })) return fail();
  return Object.freeze({ ...status, proof: Object.freeze(proof), receipt: Object.freeze(receipt) });
}

/** Recover the original acceptance only from an authenticated read-v5 response.
 * not_found is a read observation, never permission to repeat a spent dispatch. */
export function parseSecondBrainRecoveredRequestStatus(value: unknown, request: MemoryScopedWriteRequestMaterial,
  at: Date, expectedAcceptance?: unknown): Readonly<Record<string, unknown>> {
  const created = new Date(request.created_at);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(created.getTime()) || created > at) return fail();
  request = parseMemoryScopedWriteRequestJson(canonicalize(request), request.provider_instance_id, created);
  const status = object(value);
  if (status.state === "not_found") {
    exact(status, ["schema_version", "provider_instance_id", "request_id", "request_digest", "scope_digest", "state"]);
    if (status.schema_version !== 4 || status.provider_instance_id !== request.provider_instance_id
      || status.request_id !== request.request_id || status.request_digest !== request.request_digest
      || status.scope_digest !== request.preparation.binding.identity_digest) return fail();
    return Object.freeze(status);
  }
  const accepted = parseSecondBrainScopedWriteAccepted(status.acceptance, request, at);
  if (!accepted.replayed) return fail();
  if (expectedAcceptance !== undefined) {
    const original = parseSecondBrainScopedWriteAccepted(expectedAcceptance, request, at);
    if (original.accepted_at !== accepted.accepted_at || original.request_file_digest !== accepted.request_file_digest) return fail();
  }
  const previous = { ...status };
  delete previous.acceptance;
  return Object.freeze({ ...parseSecondBrainScopedRequestStatus(previous, request, accepted, at), acceptance: accepted });
}
