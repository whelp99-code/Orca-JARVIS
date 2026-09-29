import { createHash, createPublicKey, sign } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../../src/canonical.js";
import { signCommandApproval } from "../../src/control-plane.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { MemoryEffectSpool } from "../../src/memory-effect-spool.js";
import { parseCorrectionSpool } from "../../src/memory-correction-dispatch.js";
import { registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { verifyMemoryDispositionProof } from "../../src/memory-disposition-proof.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import type { MemoryDeletionRecord } from "../../src/memory-deletion-store.js";
import type { DeletionLifecycleObservation } from "../../src/memory-lifecycle-observation-types.js";
import { correctionPreparedFixture } from "./memory-correction-control.js";
import { providerSurfaceInventory, reingressGuardObservations } from "./memory-surface-observations.js";
import { localKey } from "../helpers.js";

export async function deletionPreparedFixture() {
  const f = await correctionPreparedFixture();
  try {
    const preparation = z.object({ spool_locator: z.string(), spool_digest: z.string() }).parse(
      f.db.db.prepare("SELECT spool_locator,spool_digest FROM memory_effect_preparations").get());
    const staged = parseCorrectionSpool(await new MemoryEffectSpool(f.runtime.spool_root, f.db)
      .read(preparation.spool_locator, preparation.spool_digest));
    let observation: DeletionLifecycleObservation | undefined;
    const runtime = { ...f.runtime, observer: { ...f.runtime.observer,
      deletion: async () => observation ?? { kind: "not_proved" as const, code: "TEST_PENDING" } } };
    const saga = new MemoryDeletionSaga(runtime);
    const action = await saga.prepare({ deletion_id: "deletion:recovery", correlation_id: "correlation:recovery",
      provider_instance_id: staged.provider_instance_id, targets: staged.targets, scope: staged.scope,
      erasure_claim: "managed_erasure", external_receipts: [], requested_at: f.runtime.clock(),
      expires_at: new Date(staged.expires_at), nonce: "nonce:deletion-recovery" });
    const command = f.control.stage(action, f.runtime.clock());
    f.control.decide(signCommandApproval({ schema_version: 1, receipt_id: "approval:deletion-recovery",
      request_id: action.request_id, decision: "approve", command_digest: command.command_digest,
      signer_principal_id: "principal:owner", authenticated_session_id: "recovery", key_id: "decision-test",
      algorithm: "Ed25519", issued_at: f.runtime.clock().toISOString(), not_before: f.runtime.clock().toISOString(),
      expires_at: action.expires_at, nonce: "nonce:approval-recovery", max_uses: 1, status: "issued",
    }, localKey(f.db)), f.runtime.clock());
    return { ...f, runtime, saga, action, correction: { saga: f.saga, claim: f.claim },
      claim: f.control.claim(action.request_id, "fixture", f.runtime.clock()),
      setObservation: (value: DeletionLifecycleObservation) => { observation = value; } };
  } catch (error) { await f.close(); throw error; }
}

export function deletionObservation(f: Pick<Awaited<ReturnType<typeof deletionPreparedFixture>>, "db">
  & { readonly runtime: Pick<Awaited<ReturnType<typeof deletionPreparedFixture>>["runtime"], "clock" | "private_key">;
    readonly writer: { readonly calls: readonly MemoryEffectWriteRequestV2[] } },
  record: MemoryDeletionRecord): DeletionLifecycleObservation {
  const request = f.writer.calls[0];
  const entry = request?.tombstone_chain_delta[0];
  if (request === undefined || entry === undefined) throw new Error("DELETION_REQUEST_MISSING");
  const now = f.runtime.clock();
  registerMemoryProviderProofKey(f.db, { key_id: "provider:recovery", provider_instance_id: request.provider_instance_id,
    provider_release_sha: "a".repeat(40), public_key_pem: createPublicKey(f.runtime.private_key)
      .export({ format: "pem", type: "spki" }).toString(), valid_from: request.created_at,
    valid_until: request.expires_at }, now);
  const body = { schema_version: 1, proof_type: "forget", provider_instance_id: request.provider_instance_id,
    provider_release_sha: "a".repeat(40), provider_signing_key_id: "provider:recovery",
    request_id: request.request_id, request_digest: request.request_digest, envelope_digest: request.envelope_digest,
    idempotency_key: request.idempotency_key, delegation_id: request.delegation.delegation_id,
    delegation_digest: request.delegation.delegation_digest, lane_id: request.lane_id, operation: request.operation,
    payload_digest: request.delegation.payload_digest, target_manifest_digest: request.target_manifest_digest,
    scope_digest: request.scope_digest, base_generation_id: request.expected_prior.generation_id,
    base_head: request.expected_prior.vault_head, base_tree: request.expected_prior.vault_tree,
    result_generation_id: `sbgen:v1:${"b".repeat(64)}`, result_head: "c".repeat(40), result_tree: "d".repeat(40),
    tombstone_sequence: request.tombstone_high_water.sequence, tombstone_previous_root: entry.previous_root,
    tombstone_set_root: request.tombstone_high_water.set_root,
    activation_journal_digest: `sha256:${"1".repeat(64)}`, reader_drain_digest: `sha256:${"2".repeat(64)}`,
    predecessor_disposal_digest: `sha256:${"3".repeat(64)}`, backup_disposal_digest: `sha256:${"4".repeat(64)}`,
    export_disposal_digest: `sha256:${"5".repeat(64)}`, surface_manifest_digest: `sha256:${"6".repeat(64)}`,
    artifact_manifest_digest: null, export_manifest_digest: null,
    claimed_at: now.toISOString(), applied_at: now.toISOString(), completed_at: now.toISOString() };
  const proofDigest = `sha256:${createHash("sha256").update("second-brain/memory-disposition-proof/v1\0")
    .update(canonicalize(body)).digest("hex")}`;
  const unsigned = { ...body, proof_id: `sbproof:v1:${proofDigest.slice(7)}`, proof_digest: proofDigest };
  const signed = { ...unsigned, signature: sign(null,
    Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(unsigned)}`), f.runtime.private_key).toString("base64url") };
  const proof = verifyMemoryDispositionProof(f.db, signed, {
    ...request, delegation_id: request.delegation.delegation_id, delegation_digest: request.delegation.delegation_digest,
    payload_digest: request.delegation.payload_digest, tombstone_sequence: entry.sequence, tombstone_set_root: entry.set_root,
  }, now);
  if (record.request_id !== proof.request_id) throw new Error("DELETION_PROOF_MISMATCH");
  return { kind: "deletion", proof, generation: { generation_id: proof.result_generation_id,
    generation_manifest_digest: `sha256:${"b".repeat(64)}`, tombstone_sequence: proof.tombstone_sequence,
    tombstone_set_root: proof.tombstone_set_root },
    absence: { kind: "deletion", target_manifest_digest: proof.target_manifest_digest,
      absence_manifest_digest: `sha256:${"7".repeat(64)}`, scanned_surface_count: 40,
      match_count: 0, error_count: 0, omission_count: 0 }, provider_inventory: providerSurfaceInventory(), reingress_guards: reingressGuardObservations() };
}
