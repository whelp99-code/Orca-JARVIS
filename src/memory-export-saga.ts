import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import { ControlPlane } from "./control-plane.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import {
  MemoryEffectScopeSchema,
  MemoryExportPayloadSchema,
  ResolvedMemoryTargetSchema,
} from "./memory-effect-write-zod.js";
import { MemoryExportStore, type MemoryExportRecord } from "./memory-export-store.js";
import type { MemoryExportSagaOptions, PrepareMemoryExportInput } from "./memory-export-types.js";
import { MemoryTombstoneChain } from "./memory-tombstone-chain.js";
import { memoryExpectedPrior, memoryTargetManifestDigest, memoryTargetScopeDigest, sameMemoryGeneration } from "./memory-target-values.js";
import type { SecondBrainWriteOutcome } from "./second-brain-adapter-types.js";
import {
  createMemoryEffectWriteRequest,
  memoryEffectDigest,
  parseMemoryEffectAccepted,
  type MemoryEffectScopeV2,
  type MemoryEffectWriteRequestV2,
  type MemoryExportPayloadV2,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
const exportSpool = z.object({ schema_version: z.literal(1), lane_id: z.string(), export_id: z.string(),
  provider_instance_id: z.string(), targets: z.array(ResolvedMemoryTargetSchema).min(1).max(64),
  scope: MemoryEffectScopeSchema, payload: MemoryExportPayloadSchema,
  created_at: z.string(), expires_at: z.string(), nonce: z.string() }).strict();

export type { MemoryExportSagaOptions, PrepareMemoryExportInput } from "./memory-export-types.js";
export class MemoryExportSaga {
  private readonly store: MemoryExportStore; private readonly spool: MemoryEffectSpool;
  private readonly chain: MemoryTombstoneChain; private readonly control: ControlPlane;
  constructor(private readonly options: MemoryExportSagaOptions) {
    this.store = new MemoryExportStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.chain = new MemoryTombstoneChain(options.authority, options.subject_key);
    this.control = new ControlPlane(options.authority);
  }
  async prepare(input: PrepareMemoryExportInput): Promise<ControlCommandRequestInput> {
    if (input.targets.length < 1 || input.targets.length > 64 || !sameMemoryGeneration(input.targets)
      || input.targets.some(target => target.provider_instance_id !== input.provider_instance_id)
      || input.scope.format !== "json" || input.expires_at.getTime() <= input.requested_at.getTime()
      || input.expires_at.getTime() - input.requested_at.getTime() > 15 * 60_000) {
      throw new JarvisError("MEMORY_EXPORT_INPUT_INVALID");
    }
    const targetManifest = memoryTargetManifestDigest(input.targets);
    const scopeDigest = memoryTargetScopeDigest(input.targets, input.scope);
    const payload: MemoryExportPayloadV2 = { format: "json",
      target_record_ids: input.targets.map(target => target.target_id).sort(),
      sensitivity_classes: input.scope.sensitivity_classes,
      valid_from: input.scope.valid_from, valid_until: input.scope.valid_until,
      max_records: input.scope.max_records, max_bytes: input.scope.max_bytes };
    const payloadDigest = memoryEffectDigest("effect_payload", payload);
    const laneDigest = hash("orca-jarvis/memory-export-request/v1\0", {
      export_id: input.export_id, target_manifest_digest: targetManifest,
      scope_digest: scopeDigest, payload_digest: payloadDigest,
    });
    const laneId = `memexp:req:v1:${laneDigest.slice(7)}`;
    const idempotency = `memexp:idem:v1:${hash("orca-jarvis/memory-export-idempotency/v1\0", {
      export_id: input.export_id, lane_id: laneId,
    }).slice(7)}`;
    const high = this.chain.highWater();
    const spool = await this.spool.write(laneId, { schema_version: 1, lane_id: laneId,
      export_id: input.export_id, provider_instance_id: input.provider_instance_id,
      targets: input.targets, scope: input.scope, payload,
      created_at: input.requested_at.toISOString(), expires_at: input.expires_at.toISOString(),
      nonce: input.nonce });
    this.options.authority.db.prepare(
      `INSERT INTO memory_effect_preparations(
        lane_id,lane,operation,provider_instance_id,target_manifest_digest,scope_digest,payload_digest,
        spool_locator,spool_digest,state,expires_at,created_at,updated_at
       ) VALUES(?,'export','export',?,?,?,?,?,?,'staged',?,?,?)`,
    ).run(laneId, input.provider_instance_id, targetManifest, scopeDigest, payloadDigest,
      spool.locator, spool.digest, input.expires_at.toISOString(), input.requested_at.toISOString(),
      input.requested_at.toISOString());
    this.store.request({ export_id: input.export_id, lane_id: laneId,
      correlation_id: input.correlation_id, idempotency_key: idempotency,
      provider_instance_id: input.provider_instance_id, scope_digest: scopeDigest,
      target_manifest_digest: targetManifest, payload_digest: payloadDigest,
      tombstone_sequence: high.sequence, tombstone_set_root: high.set_root,
      spool_locator: spool.locator, spool_digest: spool.digest,
      expires_at: input.expires_at.toISOString() }, input.targets.map(target => target.target_digest),
    input.requested_at);
    return { schema_version: 1, request_id: `control:${input.export_id}`, action: "memory.export",
      action_level: 3, target: { export_id: input.export_id,
        target_manifest_digest: targetManifest, scope_digest: scopeDigest },
      args: { schema_version: 3, lane: "export", lane_id: laneId,
        provider_instance_id: input.provider_instance_id, target_manifest_digest: targetManifest,
        scope_digest: scopeDigest, payload_digest: payloadDigest, spool_digest: spool.digest,
        expires_at: input.expires_at.toISOString() }, reversible: false,
      requested_by: "principal:owner", requested_at: input.requested_at.toISOString(),
      expires_at: input.expires_at.toISOString(), nonce: input.nonce };
  }
  async dispatch(command: ClaimedControlCommand): Promise<MemoryExportRecord> {
    const now = this.options.clock();
    if (command.action !== "memory.export" || command.action_level !== 3
      || command.args.schema_version !== 3 || command.args.lane !== "export"
      || typeof command.target.export_id !== "string" || typeof command.args.lane_id !== "string") {
      throw new JarvisError("MEMORY_EXPORT_AUTHORITY_INVALID");
    }
    const id = command.target.export_id; const laneId = command.args.lane_id;
    const row = this.store.get(id);
    const preparation = this.options.authority.db.prepare(
      "SELECT * FROM memory_effect_preparations WHERE lane_id=? AND lane='export'",
    ).get(laneId) as { readonly spool_locator: string; readonly spool_digest: string;
      readonly state: string } | undefined;
    if (row === undefined || preparation === undefined || preparation.state !== "staged"
      || preparation.spool_digest !== command.args.spool_digest) {
      throw new JarvisError("MEMORY_EXPORT_AUTHORITY_INVALID");
    }
    const parsed = exportSpool.safeParse(await this.spool.read(preparation.spool_locator,
      preparation.spool_digest));
    if (!parsed.success) throw new JarvisError("MEMORY_EXPORT_SPOOL_INVALID");
    const targets: ResolvedMemoryTargetV2[] = parsed.data.targets;
    const scope: MemoryEffectScopeV2 = parsed.data.scope;
    const payload: MemoryExportPayloadV2 = parsed.data.payload;
    const status = await this.options.provider.generationStatus();
    if (status.kind !== "data" || typeof status.value.tombstone_sequence !== "number") {
      throw new JarvisError("MEMORY_EXPORT_PROVIDER_STALE");
    }
    const high = this.chain.highWater();
    if (row.tombstone_sequence !== high.sequence || row.tombstone_set_root !== high.set_root) {
      throw new JarvisError("MEMORY_EXPORT_TOMBSTONE_STALE");
    }
    this.store.approve(id, { request_id: command.request_id, receipt_id: command.receipt_id,
      command_digest: command.command_digest }, now);
    const firstTarget = targets[0];
    if (firstTarget === undefined) throw new JarvisError("MEMORY_EXPORT_TARGET_MISSING");
    const request = createMemoryEffectWriteRequest({ schema_version: 2, kind: "memory_effect",
      provider_instance_id: row.provider_instance_id, lane: "export", lane_id: laneId,
      operation: "export", target_manifest_digest: row.target_manifest_digest, targets, scope,
      scope_digest: row.scope_digest, expected_prior: memoryExpectedPrior(firstTarget),
      tombstone_high_water: high,
      tombstone_chain_delta: this.chain.delta(status.value.tombstone_sequence),
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
    const writing = this.store.begin(id, now); const outcome = await this.options.writer.write(request);
    await this.recordOutcome(writing, request, outcome, now); return this.store.get(id) ?? writing;
  }
  async reconcile(id: string): Promise<MemoryExportRecord> {
    const row = this.store.get(id); if (row === undefined) throw new JarvisError("MEMORY_EXPORT_NOT_FOUND");
    if (["available", "expired", "invalidated"].includes(row.state)) return row;
    if (row.request_id === null || row.request_digest === null || row.envelope_digest === null
      || row.provider_idempotency_key === null || row.delegation_id === null || row.delegation_digest === null) return row;
    const observed = await this.options.observer.export(row);
    if (observed.kind === "not_proved") return row;
    const proof = observed.proof;
    const now = this.options.clock();
    this.store.proved(id, { proof_id: proof.proof_id, proof_digest: proof.proof_digest,
      provider_release_sha: proof.provider_release_sha,
      generation_id: observed.generation.generation_id,
      export_manifest_digest: observed.export.export_manifest_digest,
      surface_manifest_digest: proof.surface_manifest_digest,
      proof_json: canonicalize(proof) }, now);
    await this.options.barriers.reach({ barrier_id: "jarvis_proof_observation",
      lane_id: row.lane_id, request_id: row.request_id,
      tombstone_sequence: row.tombstone_sequence, now });
    await this.options.barriers.reach({ barrier_id: "before_settlement_commit",
      lane_id: row.lane_id, request_id: row.request_id,
      tombstone_sequence: row.tombstone_sequence, now });
    const available = this.store.available(id, observed.export.file_count,
      observed.export.byte_count, new Date(proof.completed_at));
    this.options.authority.db.prepare(
      "UPDATE memory_effect_preparations SET state='consumed',updated_at=? WHERE lane_id=? AND state='approved'",
    ).run(now.toISOString(), row.lane_id);
    const control = this.options.authority.db.prepare(
      "SELECT state,lease_fence FROM control_command_requests WHERE request_id=?",
    ).get(row.control_request_id) as { readonly state: string; readonly lease_fence: number } | undefined;
    if (control?.state === "claimed" && row.control_request_id !== null) this.control.settle(
      row.control_request_id, control.lease_fence, { state: "completed", effect_type: "memory.export.available",
        payload: { export_id: id, proof_digest: proof.proof_digest,
          export_manifest_digest: proof.export_manifest_digest } }, now);
    return available;
  }
  private async recordOutcome(row: MemoryExportRecord, request: MemoryEffectWriteRequestV2,
    outcome: SecondBrainWriteOutcome, now: Date): Promise<void> {
    if (outcome.kind === "accepted" && outcome.schema_version === 2) {
      const accepted = parseMemoryEffectAccepted(outcome);
      if (accepted === undefined || accepted.request_id !== request.request_id) {
        throw new JarvisError("MEMORY_EXPORT_ACCEPTANCE_INVALID");
      }
      if (row.spool_locator === null || row.spool_digest === null) {
        throw new JarvisError("MEMORY_EXPORT_SPOOL_MISSING");
      }
      await this.spool.remove(row.lane_id, row.spool_locator, row.spool_digest, "accepted", now);
      this.store.accepted(row.export_id, accepted, accepted.queue_locator, now); return;
    }
    this.store.uncertain(row.export_id, "code" in outcome ? outcome.code : "MEMORY_EXPORT_UNCERTAIN", now);
  }
}
