import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import { ControlPlane } from "./control-plane.js";
import { MemoryCorrectionDispatcher } from "./memory-correction-dispatcher.js";
import { MemoryCorrectionStore, type MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { MemoryCorrectionSagaOptions, PrepareMemoryCorrectionInput } from "./memory-correction-types.js";
import { purgeMemoryContent } from "./memory-content-purge.js";
import { verifyMemoryDispositionProof } from "./memory-disposition-proof.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import {
  memoryTargetManifestDigest,
  memoryTargetScopeDigest,
  sameMemoryGeneration,
} from "./memory-target-values.js";
import {
  memoryEffectDigest,
  type MemoryCorrectionPayloadV2,
} from "./second-brain-effect-v2.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
export type { MemoryCorrectionSagaOptions, PrepareMemoryCorrectionInput } from "./memory-correction-types.js";

export { confirmMemoryCorrectionCandidate } from "./memory-correction-confirmation.js";

export class MemoryCorrectionSaga {
  private readonly store: MemoryCorrectionStore;
  private readonly spool: MemoryEffectSpool;
  private readonly dispatcher: MemoryCorrectionDispatcher;
  private readonly control: ControlPlane;

  constructor(private readonly options: MemoryCorrectionSagaOptions) {
    this.store = new MemoryCorrectionStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.dispatcher = new MemoryCorrectionDispatcher(options);
    this.control = new ControlPlane(options.authority);
  }

  async prepare(input: PrepareMemoryCorrectionInput): Promise<ControlCommandRequestInput> {
    const now = input.requested_at;
    if (!sameMemoryGeneration(input.targets) || input.targets.length !== 1
      || input.targets[0].provider_instance_id !== input.provider_instance_id
      || input.scope.format !== "none" || input.content !== input.content.normalize("NFC")
      || input.content.trim() !== input.content || Buffer.byteLength(input.content, "utf8") > 4_096
      || input.expires_at.getTime() <= now.getTime()
      || input.expires_at.getTime() - now.getTime() > 15 * 60_000) {
      throw new JarvisError("MEMORY_CORRECTION_INPUT_INVALID");
    }
    const candidate = this.options.authority.db.prepare(
      `SELECT m.candidate_digest,m.classification_digest,c.state,c.operation,c.required_confirmation,
       c.confirmation_receipt_id FROM memory_candidates c
       JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
       WHERE c.candidate_id=?`,
    ).get(input.candidate_id) as { readonly candidate_digest: string; readonly classification_digest: string;
      readonly state: string; readonly operation: string; readonly required_confirmation: number;
      readonly confirmation_receipt_id: string | null } | undefined;
    if (candidate === undefined || candidate.state !== "approved" || candidate.operation !== "correct"
      || candidate.required_confirmation !== 1 || candidate.confirmation_receipt_id === null) {
      throw new JarvisError("MEMORY_CORRECTION_CONFIRMATION_REQUIRED");
    }
    const targetManifestDigest = memoryTargetManifestDigest(input.targets);
    const scopeDigest = memoryTargetScopeDigest(input.targets, input.scope);
    const contentDigest = memoryEffectDigest("effect_content", { content: input.content });
    const payload: MemoryCorrectionPayloadV2 = { content: input.content, content_digest: contentDigest,
      content_bytes: Buffer.byteLength(input.content, "utf8"), disposition: "superseded" };
    const payloadDigest = memoryEffectDigest("effect_payload", payload);
    const laneDigest = hash("orca-jarvis/memory-correction-request/v1\0", {
      candidate_id: input.candidate_id, target_manifest_digest: targetManifestDigest,
      scope_digest: scopeDigest, payload_digest: payloadDigest, expires_at: input.expires_at.toISOString(),
    });
    const laneId = `memcorr:req:v1:${laneDigest.slice(7)}`;
    const spool = await this.spool.write(laneId, {
      schema_version: 1, lane_id: laneId, candidate_id: input.candidate_id,
      provider_instance_id: input.provider_instance_id, targets: input.targets, scope: input.scope,
      content: input.content, created_at: now.toISOString(), expires_at: input.expires_at.toISOString(),
      nonce: input.nonce,
    });
    this.options.authority.db.prepare(
      `INSERT INTO memory_effect_preparations(
        lane_id,lane,operation,provider_instance_id,candidate_id,target_manifest_digest,scope_digest,
        payload_digest,spool_locator,spool_digest,state,expires_at,created_at,updated_at
       ) VALUES(?,'correction','correct',?,?,?,?,?,?,?,'staged',?,?,?)`,
    ).run(laneId, input.provider_instance_id, input.candidate_id, targetManifestDigest,
      scopeDigest, payloadDigest, spool.locator, spool.digest, input.expires_at.toISOString(),
      now.toISOString(), now.toISOString());
    return {
      schema_version: 1,
      request_id: input.control_request_id,
      action: "memory.outbox.dispatch",
      action_level: 3,
      target: { candidate_id: input.candidate_id, candidate_digest: candidate.candidate_digest,
        classification_digest: candidate.classification_digest },
      args: { schema_version: 3, lane: "correction", lane_id: laneId,
        provider_instance_id: input.provider_instance_id, target_manifest_digest: targetManifestDigest,
        scope_digest: scopeDigest, payload_digest: payloadDigest, spool_digest: spool.digest,
        expires_at: input.expires_at.toISOString() },
      reversible: false,
      requested_by: "principal:owner",
      requested_at: now.toISOString(),
      expires_at: input.expires_at.toISOString(),
      nonce: input.nonce,
    };
  }

  dispatch(command: ClaimedControlCommand): Promise<MemoryCorrectionRecord> {
    return this.dispatcher.dispatch(command);
  }

  async reconcile(correctionId: string): Promise<MemoryCorrectionRecord> {
    const record = this.store.get(correctionId);
    if (record === undefined) throw new JarvisError("MEMORY_CORRECTION_NOT_FOUND");
    if (record.state === "settled" || record.state === "conflict") return record;
    const status = await this.options.provider.requestStatus(record.request_id);
    if (status.kind !== "data" || status.value.state !== "proved") return record;
    const proof = verifyMemoryDispositionProof(this.options.authority, status.value.proof, {
      provider_instance_id: record.provider_instance_id, request_id: record.request_id,
      request_digest: record.request_digest, envelope_digest: record.envelope_digest,
      idempotency_key: record.idempotency_key, delegation_id: record.delegation_id,
      delegation_digest: record.delegation_digest, lane_id: record.lane_id, operation: "correct",
      payload_digest: record.payload_digest, target_manifest_digest: record.target_manifest_digest,
      scope_digest: record.scope_digest, tombstone_sequence: record.tombstone_sequence,
      tombstone_set_root: record.tombstone_set_root,
    }, this.options.clock());
    if (!await this.options.artifact_verified(proof)) {
      throw new JarvisError("MEMORY_CORRECTION_ARTIFACT_INVALID");
    }
    const restarted = await this.options.provider.restartForGeneration(proof.result_generation_id);
    if (restarted.kind !== "data") throw new JarvisError("MEMORY_CORRECTION_RESTART_REQUIRED");
    const now = this.options.clock();
    this.store.providerProved(correctionId, { proof_id: proof.proof_id,
      proof_digest: proof.proof_digest, provider_release_sha: proof.provider_release_sha,
      result_generation_id: proof.result_generation_id,
      surface_manifest_digest: proof.surface_manifest_digest,
      artifact_manifest_digest: proof.artifact_manifest_digest ?? "",
      proof_json: canonicalize(proof) }, now);
    const purge = purgeMemoryContent({ authority: this.options.authority, lane: "correction",
      lane_id: record.lane_id, target_manifest_digest: record.target_manifest_digest,
      scope_digest: record.scope_digest, tombstone_sequence: record.tombstone_sequence,
      tombstone_set_root: record.tombstone_set_root, needles: this.options.purge_needles(record),
      managed_roots: this.options.managed_roots, backup_roots: this.options.backup_roots, now });
    const settled = this.store.settle(correctionId, purge.receipt_digest, now);
    this.options.authority.db.prepare(
      `UPDATE memory_effect_preparations SET state='consumed',updated_at=?
       WHERE lane_id=? AND state='approved'`,
    ).run(now.toISOString(), record.lane_id);
    const control = this.options.authority.db.prepare(
      "SELECT state,lease_fence FROM control_command_requests WHERE request_id=?",
    ).get(record.control_request_id) as { readonly state: string; readonly lease_fence: number };
    if (control.state === "claimed") this.control.settle(record.control_request_id,
      control.lease_fence, { state: "completed", effect_type: "memory.correction.settled",
        payload: { correction_id: correctionId, request_digest: record.request_digest,
          proof_digest: proof.proof_digest, purge_receipt_digest: purge.receipt_digest } }, now);
    return settled;
  }
}
