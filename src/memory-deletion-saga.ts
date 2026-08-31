import { createHash, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import { ControlPlane } from "./control-plane.js";
import { purgeMemoryContent } from "./memory-content-purge.js";
import { MemoryDeletionStore, type MemoryDeletionRecord } from "./memory-deletion-store.js";
import { verifyMemoryDispositionProof } from "./memory-disposition-proof.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import {
  MemoryDeletionPayloadSchema,
  MemoryEffectScopeSchema,
  ResolvedMemoryTargetSchema,
} from "./memory-effect-write-zod.js";
import { MemoryTombstoneChain } from "./memory-tombstone-chain.js";
import { memoryExpectedPrior, memoryTargetManifestDigest, memoryTargetScopeDigest, sameMemoryGeneration } from "./memory-target-values.js";
import type { SecondBrainWriteOutcome, SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";
import {
  createMemoryEffectWriteRequest,
  memoryEffectDigest,
  parseMemoryEffectAccepted,
  type ExternalErasureReceiptV2,
  type MemoryDeletePayloadV2,
  type MemoryEffectScopeV2,
  type MemoryEffectWriteRequestV2,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
const deletionSpool = z.object({
  schema_version: z.literal(1), lane_id: z.string(), deletion_id: z.string(), provider_instance_id: z.string(),
  targets: z.array(ResolvedMemoryTargetSchema).min(1).max(64),
  scope: MemoryEffectScopeSchema,
  payload: MemoryDeletionPayloadSchema,
  created_at: z.string(), expires_at: z.string(), nonce: z.string(),
}).strict();

export type PrepareMemoryDeletionInput = {
  readonly deletion_id: string; readonly correlation_id: string;
  readonly provider_instance_id: string; readonly targets: readonly ResolvedMemoryTargetV2[];
  readonly scope: MemoryEffectScopeV2; readonly erasure_claim: "managed_erasure" | "provider_local_suppression";
  readonly external_receipts: readonly ExternalErasureReceiptV2[];
  readonly requested_at: Date; readonly expires_at: Date; readonly nonce: string;
};
export type MemoryDeletionSagaOptions = {
  readonly authority: AuthorityDb; readonly spool_root: string;
  readonly writer: SecondBrainWriteRequestAdapter; readonly provider: SecondBrainEffectService;
  readonly signing_key_id: string; readonly private_key: KeyObject; readonly subject_key: Buffer;
  readonly clock: () => Date;
  readonly absence_verified: (proof: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly purge_needles: (record: MemoryDeletionRecord) => readonly Buffer[];
  readonly managed_roots?: readonly { readonly path: string; readonly kind: "projection" | "state" | "backup" | "spool" | "restore" }[];
  readonly backup_roots?: readonly string[];
};

export class MemoryDeletionSaga {
  private readonly store: MemoryDeletionStore;
  private readonly spool: MemoryEffectSpool;
  private readonly chain: MemoryTombstoneChain;
  private readonly control: ControlPlane;
  constructor(private readonly options: MemoryDeletionSagaOptions) {
    this.store = new MemoryDeletionStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.chain = new MemoryTombstoneChain(options.authority, options.subject_key);
    this.control = new ControlPlane(options.authority);
  }
  async prepare(input: PrepareMemoryDeletionInput): Promise<ControlCommandRequestInput> {
    if (input.targets.length < 1 || input.targets.length > 64 || !sameMemoryGeneration(input.targets)
      || input.targets.some(target => target.provider_instance_id !== input.provider_instance_id)
      || input.scope.format !== "none" || input.expires_at.getTime() <= input.requested_at.getTime()
      || input.expires_at.getTime() - input.requested_at.getTime() > 15 * 60_000) {
      throw new JarvisError("MEMORY_DELETION_INPUT_INVALID");
    }
    if (input.erasure_claim === "managed_erasure"
      && input.targets.some(target => target.source_owner_class !== "provider_owned")
      && input.external_receipts.length === 0) {
      throw new JarvisError("MANAGED_ERASURE_SCOPE_INVALID");
    }
    const targetManifest = memoryTargetManifestDigest(input.targets);
    const scopeDigest = memoryTargetScopeDigest(input.targets, input.scope);
    const payload: MemoryDeletePayloadV2 = { disposition: "owner_requested",
      erasure_claim: input.erasure_claim, external_receipts: input.external_receipts };
    const payloadDigest = memoryEffectDigest("effect_payload", payload);
    const laneDigest = hash("orca-jarvis/memory-delete-request/v1\0", {
      deletion_id: input.deletion_id, target_manifest_digest: targetManifest,
      scope_digest: scopeDigest, payload_digest: payloadDigest,
    });
    const laneId = `memdel:req:v1:${laneDigest.slice(7)}`;
    const idempotencyKey = `memdel:idem:v1:${hash("orca-jarvis/memory-delete-idempotency/v1\0", {
      deletion_id: input.deletion_id, lane_id: laneId,
    }).slice(7)}`;
    const spool = await this.spool.write(laneId, { schema_version: 1, lane_id: laneId,
      deletion_id: input.deletion_id, provider_instance_id: input.provider_instance_id,
      targets: input.targets, scope: input.scope, payload, created_at: input.requested_at.toISOString(),
      expires_at: input.expires_at.toISOString(), nonce: input.nonce });
    this.options.authority.db.prepare(
      `INSERT INTO memory_effect_preparations(
        lane_id,lane,operation,provider_instance_id,target_manifest_digest,scope_digest,payload_digest,
        spool_locator,spool_digest,state,expires_at,created_at,updated_at
       ) VALUES(?,'deletion','forget',?,?,?,?,?,?,'staged',?,?,?)`,
    ).run(laneId, input.provider_instance_id, targetManifest, scopeDigest, payloadDigest,
      spool.locator, spool.digest, input.expires_at.toISOString(), input.requested_at.toISOString(),
      input.requested_at.toISOString());
    this.store.request({ deletion_id: input.deletion_id, correlation_id: input.correlation_id,
      idempotency_key: idempotencyKey, keyed_subject_digest: input.targets[0]?.subject_digest ?? "",
      scope_digest: scopeDigest, target_manifest_digest: targetManifest, payload_digest: payloadDigest,
      spool_locator: spool.locator, spool_digest: spool.digest,
      expires_at: input.expires_at.toISOString() }, input.requested_at);
    return { schema_version: 1, request_id: `control:${input.deletion_id}`, action: "memory.delete",
      action_level: 3, target: { deletion_id: input.deletion_id,
        target_manifest_digest: targetManifest, scope_digest: scopeDigest },
      args: { schema_version: 3, lane: "deletion", lane_id: laneId,
        provider_instance_id: input.provider_instance_id, target_manifest_digest: targetManifest,
        scope_digest: scopeDigest, payload_digest: payloadDigest, spool_digest: spool.digest,
        expires_at: input.expires_at.toISOString() }, reversible: false,
      requested_by: "principal:owner", requested_at: input.requested_at.toISOString(),
      expires_at: input.expires_at.toISOString(), nonce: input.nonce };
  }
  async dispatch(command: ClaimedControlCommand): Promise<MemoryDeletionRecord> {
    const now = this.options.clock();
    if (command.action !== "memory.delete" || command.action_level !== 3
      || command.args.schema_version !== 3 || command.args.lane !== "deletion"
      || typeof command.target.deletion_id !== "string" || typeof command.args.lane_id !== "string") {
      throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    }
    const id = command.target.deletion_id; const laneId = command.args.lane_id;
    const preparation = this.options.authority.db.prepare(
      "SELECT * FROM memory_effect_preparations WHERE lane_id=? AND lane='deletion'",
    ).get(laneId) as { readonly spool_locator: string; readonly spool_digest: string;
      readonly target_manifest_digest: string; readonly scope_digest: string; readonly payload_digest: string;
      readonly state: string } | undefined;
    const row = this.store.get(id);
    if (preparation === undefined || preparation.state !== "staged" || row === undefined
      || preparation.spool_digest !== command.args.spool_digest
      || row.target_manifest_digest !== command.args.target_manifest_digest
      || row.scope_digest !== command.args.scope_digest) throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    const parsed = deletionSpool.safeParse(await this.spool.read(preparation.spool_locator,
      preparation.spool_digest));
    if (!parsed.success) throw new JarvisError("MEMORY_DELETION_SPOOL_INVALID");
    const targets: ResolvedMemoryTargetV2[] = parsed.data.targets;
    const scope: MemoryEffectScopeV2 = parsed.data.scope;
    const payload: MemoryDeletePayloadV2 = parsed.data.payload;
    const receipt = this.options.authority.db.prepare(
      "SELECT payload_json,signature FROM control_command_receipts WHERE receipt_id=? AND request_id=?",
    ).get(command.receipt_id, command.request_id) as { readonly payload_json: string; readonly signature: string } | undefined;
    if (receipt === undefined) throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    const providerSequence = this.chain.highWater().sequence;
    this.store.approve(id, { lane_id: laneId, provider_instance_id: parsed.data.provider_instance_id,
      control_request_id: command.request_id, control_receipt_id: command.receipt_id,
      control_command_digest: command.command_digest }, now);
    const appended = this.chain.append({ operation: "forget", lane_id: laneId, targets,
      target_manifest_digest: row.target_manifest_digest, scope_digest: row.scope_digest,
      authority_receipt_digest: hash("orca-jarvis/memory-delete-receipt/v1\0", receipt),
      payload_digest: row.payload_digest, effective_at: now.toISOString() });
    this.store.suppress(id, appended.entry.sequence, appended.entry.set_root, now);
    const firstTarget = targets[0];
    if (firstTarget === undefined) throw new JarvisError("MEMORY_DELETION_TARGET_MISSING");
    const request = createMemoryEffectWriteRequest({ schema_version: 2, kind: "memory_effect",
      provider_instance_id: parsed.data.provider_instance_id, lane: "deletion", lane_id: laneId,
      operation: "forget", target_manifest_digest: row.target_manifest_digest, targets,
      scope, scope_digest: row.scope_digest, expected_prior: memoryExpectedPrior(firstTarget),
      tombstone_high_water: appended.high_water,
      tombstone_chain_delta: this.chain.delta(providerSequence),
      created_at: parsed.data.created_at, expires_at: parsed.data.expires_at, payload },
    { principal_id: "principal:owner", not_before: parsed.data.created_at,
      nonce: parsed.data.nonce, signing_key_id: this.options.signing_key_id }, this.options.private_key);
    const locator = await this.spool.rename(preparation.spool_locator, request.request_id);
    this.options.authority.db.prepare(
      "UPDATE memory_effect_preparations SET spool_locator=?,state='approved',updated_at=? WHERE lane_id=?",
    ).run(locator, now.toISOString(), laneId);
    this.store.queue(id, { request_id: request.request_id, request_digest: request.request_digest,
      envelope_digest: request.envelope_digest, provider_idempotency_key: request.idempotency_key,
      delegation_id: request.delegation.delegation_id,
      delegation_digest: request.delegation.delegation_digest, spool_locator: locator }, now);
    this.chain.link(appended.entry.sequence, request.delegation.delegation_digest,
      request.request_digest, now);
    const applying = this.store.begin(id, now);
    const outcome = await this.options.writer.write(request);
    await this.recordOutcome(applying, request, outcome, now);
    return this.store.get(id) ?? applying;
  }
  async reconcile(id: string): Promise<MemoryDeletionRecord> {
    const row = this.store.get(id); if (row === undefined) throw new JarvisError("MEMORY_DELETION_NOT_FOUND");
    if (row.state === "settled") return row;
    if (row.request_id === null || row.request_digest === null || row.envelope_digest === null
      || row.provider_idempotency_key === null || row.delegation_id === null || row.delegation_digest === null
      || row.provider_instance_id === null || row.tombstone_sequence === null
      || row.tombstone_set_root === null) return row;
    const status = await this.options.provider.requestStatus(row.request_id);
    if (status.kind !== "data" || status.value.state !== "proved") return row;
    const proof = verifyMemoryDispositionProof(this.options.authority, status.value.proof, {
      provider_instance_id: row.provider_instance_id, request_id: row.request_id,
      request_digest: row.request_digest, envelope_digest: row.envelope_digest,
      idempotency_key: row.provider_idempotency_key,
      delegation_id: row.delegation_id, delegation_digest: row.delegation_digest,
      lane_id: row.lane_id ?? "", operation: "forget", payload_digest: row.payload_digest,
      target_manifest_digest: row.target_manifest_digest, scope_digest: row.scope_digest,
      tombstone_sequence: row.tombstone_sequence, tombstone_set_root: row.tombstone_set_root,
    }, this.options.clock());
    if (!await this.options.absence_verified(proof)) throw new JarvisError("MEMORY_DELETION_ABSENCE_INVALID");
    const restarted = await this.options.provider.restartForGeneration(proof.result_generation_id);
    if (restarted.kind !== "data") throw new JarvisError("MEMORY_DELETION_RESTART_REQUIRED");
    const now = this.options.clock();
    this.store.proved(id, { proof_id: proof.proof_id, proof_digest: proof.proof_digest,
      provider_release_sha: proof.provider_release_sha, result_generation_id: proof.result_generation_id,
      surface_manifest_digest: proof.surface_manifest_digest, proof_json: canonicalize(proof) }, now);
    const purge = purgeMemoryContent({ authority: this.options.authority, lane: "deletion",
      lane_id: row.lane_id ?? "", target_manifest_digest: row.target_manifest_digest,
      scope_digest: row.scope_digest, tombstone_sequence: row.tombstone_sequence,
      tombstone_set_root: row.tombstone_set_root, needles: this.options.purge_needles(row),
      managed_roots: this.options.managed_roots, backup_roots: this.options.backup_roots, now });
    const settled = this.store.settle(id, purge.receipt_digest, now);
    this.options.authority.db.prepare(
      "UPDATE memory_effect_preparations SET state='consumed',updated_at=? WHERE lane_id=? AND state='approved'",
    ).run(now.toISOString(), row.lane_id);
    const control = this.options.authority.db.prepare(
      "SELECT state,lease_fence FROM control_command_requests WHERE request_id=?",
    ).get(row.control_request_id) as { readonly state: string; readonly lease_fence: number } | undefined;
    if (control?.state === "claimed" && row.control_request_id !== null) this.control.settle(
      row.control_request_id, control.lease_fence, { state: "completed",
        effect_type: "memory.deletion.settled", payload: { deletion_id: id,
          proof_digest: proof.proof_digest, purge_receipt_digest: purge.receipt_digest } }, now);
    return settled;
  }
  private async recordOutcome(row: MemoryDeletionRecord, request: MemoryEffectWriteRequestV2,
    outcome: SecondBrainWriteOutcome, now: Date): Promise<void> {
    if (outcome.kind === "accepted" && outcome.schema_version === 2) {
      const accepted = parseMemoryEffectAccepted(outcome);
      if (accepted === undefined || accepted.request_id !== request.request_id) {
        throw new JarvisError("MEMORY_DELETION_ACCEPTANCE_INVALID");
      }
      if (row.spool_locator === null || row.spool_digest === null || row.lane_id === null) {
        throw new JarvisError("MEMORY_DELETION_SPOOL_MISSING");
      }
      await this.spool.remove(row.lane_id, row.spool_locator, row.spool_digest, "accepted", now);
      this.store.accepted(row.deletion_id, accepted, accepted.queue_locator, now); return;
    }
    this.store.uncertain(row.deletion_id, "code" in outcome ? outcome.code : "MEMORY_DELETION_UNCERTAIN", now);
  }
}
