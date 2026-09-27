import { z } from "zod";
import { MemoryDestructiveDispatchCursor } from "./memory-destructive-dispatch.js";
import { resumeMemoryDestructiveEffect } from "./memory-destructive-recovery.js";
import { recoverOrCompactMemory } from "./memory-compaction-resume.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import { reconcileDeletionControl } from "./memory-deletion-control.js";
import { MemoryDeletionDispatcher } from "./memory-deletion-dispatch.js";
import { MemoryDeletionStore, type MemoryDeletionRecord } from "./memory-deletion-store.js";
import type { MemoryDeletionSagaOptions, PrepareMemoryDeletionInput } from "./memory-deletion-types.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { memoryTargetManifestDigest, memoryTargetScopeDigest, sameMemoryGeneration } from "./memory-target-values.js";
import {
  memoryEffectDigest,
  type MemoryDeletePayloadV2,
} from "./second-brain-effect-v2.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
export type { MemoryDeletionSagaOptions, PrepareMemoryDeletionInput } from "./memory-deletion-types.js";

export class MemoryDeletionSaga {
  private readonly store: MemoryDeletionStore;
  private readonly spool: MemoryEffectSpool;
  private readonly dispatcher: MemoryDeletionDispatcher;
  constructor(private readonly options: MemoryDeletionSagaOptions) {
    this.store = new MemoryDeletionStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.dispatcher = new MemoryDeletionDispatcher(options);
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
  dispatch(command: ClaimedControlCommand): Promise<MemoryDeletionRecord> {
    return this.dispatcher.dispatch(command);
  }

  async reconcile(id: string): Promise<MemoryDeletionRecord> {
    let row = this.store.get(id); if (row === undefined) throw new JarvisError("MEMORY_DELETION_NOT_FOUND");
    if (row.state === "settled") return row;
    if ((row.state === "queued" || row.state === "applying") && row.lane_id !== null) {
      await resumeMemoryDestructiveEffect(this.options, row.lane_id);
      row = this.store.get(id);
      if (row === undefined) throw new JarvisError("MEMORY_DELETION_NOT_FOUND");
    }
    if (row.request_id === null || row.request_digest === null || row.envelope_digest === null
      || row.provider_idempotency_key === null || row.delegation_id === null || row.delegation_digest === null
      || row.provider_instance_id === null || row.tombstone_sequence === null
      || row.tombstone_set_root === null || row.lane_id === null) return row;
    if (row.state === "provider_proved") {
      const job = this.options.authority.db.prepare(
        `SELECT purge_id FROM memory_purge_jobs WHERE lane='deletion' AND lane_id=?
         AND target_manifest_digest=? AND scope_digest=? AND tombstone_sequence=? AND tombstone_set_root=?`,
      ).get(row.lane_id, row.target_manifest_digest, row.scope_digest, row.tombstone_sequence, row.tombstone_set_root);
      if (job !== undefined) {
        const recovered = await this.options.compactor.recover(z.object({ purge_id: z.string() }).parse(job).purge_id);
        return "state" in recovered ? row : this.complete(id, recovered.compaction_receipt_digest);
      }
    }
    const observed = await this.options.observer.deletion(row);
    if (observed.kind === "not_proved") return row;
    const proof = observed.proof;
    const now = this.options.clock();
    if (row.spool_locator !== null) {
      if (row.spool_digest === null) throw new JarvisError("MEMORY_DELETION_SPOOL_MISSING");
      await this.spool.remove(row.lane_id, row.spool_locator, row.spool_digest, "status_reconciled", now);
    }
    this.store.proved(id, { proof_id: proof.proof_id, proof_digest: proof.proof_digest,
      provider_release_sha: proof.provider_release_sha,
      result_generation_id: observed.generation.generation_id,
      surface_manifest_digest: proof.surface_manifest_digest,
      proof_json: canonicalize(proof) }, now);
    const cursor = new MemoryDestructiveDispatchCursor(this.options.authority);
    if (cursor.active().active_lane_id === row.lane_id) cursor.accepted(row.lane_id, now);
    await this.options.barriers.reach({ barrier_id: "jarvis_proof_observation",
      lane_id: row.lane_id ?? "", request_id: row.request_id,
      tombstone_sequence: row.tombstone_sequence, now });
    const purgeDigest = await recoverOrCompactMemory(this.options, { lane: "deletion",
      lane_id: row.lane_id ?? "", target_manifest_digest: row.target_manifest_digest,
      scope_digest: row.scope_digest, tombstone: { sequence: row.tombstone_sequence,
        set_root: row.tombstone_set_root }, provider_inventory: observed.provider_inventory,
      reingress_guards: observed.reingress_guards });
    if (purgeDigest === undefined) return this.store.get(id) ?? row;
    await this.options.barriers.reach({ barrier_id: "before_settlement_commit",
      lane_id: row.lane_id ?? "", request_id: row.request_id,
      tombstone_sequence: row.tombstone_sequence, now });
    return this.complete(id, purgeDigest);
  }

  private complete(id: string, purgeDigest: string): MemoryDeletionRecord {
    const now = this.options.clock();
    return this.options.authority.db.transaction(() => {
      const settled = this.store.settle(id, purgeDigest, now);
      reconcileDeletionControl(this.options.authority, settled, now);
      this.options.authority.db.prepare(
        "UPDATE memory_effect_preparations SET state='consumed',updated_at=? WHERE lane_id=? AND state='approved'",
      ).run(now.toISOString(), settled.lane_id);
      return settled;
    }).immediate();
  }

}
