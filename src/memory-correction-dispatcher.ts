import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { captureCorrectionCancellationSource } from "./memory-correction-cancellation-db.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { JarvisError } from "./db.js";
import {
  parseCorrectionSpool,
  persistCorrectionTargets,
  recordCorrectionDispatchOutcome,
} from "./memory-correction-dispatch.js";
import { captureCorrectionControlBinding, type CorrectionControlRow } from "./memory-correction-control-binding.js";
import { MemoryCorrectionStore, type MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { MemoryCorrectionSagaOptions } from "./memory-correction-types.js";
import { MemoryDestructiveDispatchCursor } from "./memory-destructive-dispatch.js";
import { MemoryDestructivePreparationStore } from "./memory-destructive-preparation.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { bindStructuredProjection } from "./memory-projection-bindings.js";
import { publishMemorySuppression } from "./memory-suppression-events.js";
import { memoryExpectedPrior } from "./memory-target-values.js";
import {
  createMemoryEffectWriteRequest,
  memoryEffectDigest,
  type MemoryCorrectionPayloadV2,
  type MemoryEffectScopeV2,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;

type PreparationRow = {
  readonly provider_instance_id: string;
  readonly candidate_id: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly payload_digest: string;
  readonly spool_locator: string;
  readonly spool_digest: string;
  readonly state: string;
  readonly expires_at: string;
  readonly provider_tombstone_sequence: number | null;
  readonly provider_tombstone_set_root: string | null;
};

export class MemoryCorrectionDispatcher {
  private readonly store: MemoryCorrectionStore;
  private readonly spool: MemoryEffectSpool;
  private readonly preparations: MemoryDestructivePreparationStore;
  private readonly cursor: MemoryDestructiveDispatchCursor;

  constructor(private readonly options: MemoryCorrectionSagaOptions) {
    this.store = new MemoryCorrectionStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.preparations = new MemoryDestructivePreparationStore(options.authority, options.subject_key);
    this.cursor = new MemoryDestructiveDispatchCursor(options.authority);
  }

  async dispatch(command: ClaimedControlCommand): Promise<MemoryCorrectionRecord> {
    const now = this.options.clock();
    const preparation = this.authorizedPreparation(command, now);
    const staged = parseCorrectionSpool(
      await this.spool.read(preparation.spool_locator, preparation.spool_digest),
    );
    const targets: readonly [ResolvedMemoryTargetV2] = staged.targets;
    const scope: MemoryEffectScopeV2 = staged.scope;
    const payload: MemoryCorrectionPayloadV2 = { content: staged.content,
      content_digest: memoryEffectDigest("effect_content", { content: staged.content }),
      content_bytes: Buffer.byteLength(staged.content, "utf8"), disposition: "superseded" };
    const receipt = this.options.authority.db.prepare(
      "SELECT payload_json,signature FROM control_command_receipts WHERE receipt_id=? AND request_id=?",
    ).get(command.receipt_id, command.request_id) as {
      readonly payload_json: string; readonly signature: string;
    } | undefined;
    if (receipt === undefined) throw new JarvisError("MEMORY_CORRECTION_AUTHORITY_INVALID");
    const providerHighWater = await this.providerHighWater(preparation);
    const laneId = command.args.lane_id;
    if (typeof laneId !== "string") throw new JarvisError("MEMORY_CORRECTION_AUTHORITY_INVALID");
    const prepared = this.preparations.prepare({ lane_id: laneId,
      provider_high_water: providerHighWater,
      tombstone: { operation: "correct", lane_id: laneId, targets,
        target_manifest_digest: preparation.target_manifest_digest,
        scope_digest: preparation.scope_digest,
        authority_receipt_digest: hash("orca-jarvis/memory-correction-receipt/v1\0", receipt),
        payload_digest: preparation.payload_digest, effective_at: now.toISOString() },
      build_request: value => createMemoryEffectWriteRequest({ schema_version: 2,
        kind: "memory_effect", provider_instance_id: staged.provider_instance_id,
        lane: "correction", lane_id: laneId, operation: "correct",
        target_manifest_digest: preparation.target_manifest_digest, targets, scope,
        scope_digest: preparation.scope_digest, expected_prior: memoryExpectedPrior(targets[0]),
        tombstone_high_water: value.high_water, tombstone_chain_delta: value.chain_delta,
        created_at: staged.created_at, expires_at: staged.expires_at, payload,
      }, { principal_id: "principal:owner", not_before: staged.created_at, nonce: staged.nonce,
        signing_key_id: this.options.signing_key_id }, this.options.private_key),
      materialize: request => {
        persistCorrectionTargets(this.options.authority, targets, now);
        bindStructuredProjection(this.options.authority.db, { kind: "control_payload",
          id: command.request_id, component_id: command.request_id }, request, now);
        const record = this.store.insert({ correction_id: `memcorr:v1:${request.request_digest.slice(7)}`,
          lane_id: laneId, candidate_id: staged.candidate_id,
          control_request_id: command.request_id, control_receipt_id: command.receipt_id,
          provider_instance_id: request.provider_instance_id, request_id: request.request_id,
          request_digest: request.request_digest, envelope_digest: request.envelope_digest,
          idempotency_key: request.idempotency_key, delegation_id: request.delegation.delegation_id,
          delegation_digest: request.delegation.delegation_digest,
          target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
          payload_digest: request.delegation.payload_digest,
          tombstone_sequence: request.tombstone_high_water.sequence,
          tombstone_set_root: request.tombstone_high_water.set_root,
          spool_locator: preparation.spool_locator, spool_digest: preparation.spool_digest,
          expires_at: request.expires_at }, command.command_digest, now);
        captureCorrectionControlBinding(this.options.authority, record as CorrectionControlRow);
        captureCorrectionCancellationSource(this.options.authority, record.correction_id, request);
      },
    });
    await this.options.barriers.reach({ barrier_id: "jarvis_suppression_tombstone_commit",
      lane_id: laneId, request_id: prepared.request.request_id,
      tombstone_sequence: prepared.entry.sequence, now });
    publishMemorySuppression(this.options.authority, prepared.entry.sequence, now);
    const correctionId = `memcorr:v1:${prepared.request.request_digest.slice(7)}`;
    let record = this.store.get(correctionId);
    if (record === undefined) throw new JarvisError("MEMORY_CORRECTION_NOT_FOUND");
    if (record.state !== "queued") return record;
    const claimed = this.options.authority.db.transaction(() => {
      const claim = this.cursor.claim({ lane_id: laneId, lane: "correction",
        sequence: prepared.entry.sequence, request_digest: prepared.request.request_digest }, now);
      if (claim.kind === "reconcile") return undefined;
      return this.store.beginDispatch(correctionId, now);
    }).immediate();
    if (claimed === undefined) return record;
    record = claimed;
    const outcome = await this.options.writer.write(prepared.request);
    await recordCorrectionDispatchOutcome(this.store, this.spool, record,
      prepared.request, outcome, now);
    if (outcome.kind === "accepted" && outcome.schema_version === 2) this.cursor.accepted(laneId, now);
    return this.store.get(correctionId) ?? record;
  }

  private authorizedPreparation(command: ClaimedControlCommand, now: Date): PreparationRow {
    if (command.action !== "memory.outbox.dispatch" || command.action_level !== 3
      || command.args.schema_version !== 3 || command.args.lane !== "correction"
      || typeof command.args.lane_id !== "string") {
      throw new JarvisError("MEMORY_CORRECTION_AUTHORITY_INVALID");
    }
    const row = this.options.authority.db.prepare(
      "SELECT * FROM memory_effect_preparations WHERE lane_id=?",
    ).get(command.args.lane_id) as PreparationRow | undefined;
    if (row === undefined || !["staged", "approved"].includes(row.state)
      || row.candidate_id !== command.target.candidate_id
      || row.target_manifest_digest !== command.args.target_manifest_digest
      || row.scope_digest !== command.args.scope_digest
      || row.payload_digest !== command.args.payload_digest
      || row.spool_digest !== command.args.spool_digest
      || Date.parse(row.expires_at) <= now.getTime()) {
      throw new JarvisError("MEMORY_CORRECTION_AUTHORITY_INVALID");
    }
    if (new MemoryProjectionAuthority(this.options.authority).isProjectionIdSuppressed(row.candidate_id)) {
      throw new JarvisError("MEMORY_CANDIDATE_SUPPRESSED");
    }
    return row;
  }

  private async providerHighWater(row: PreparationRow): Promise<{
    readonly sequence: number; readonly set_root: string;
  }> {
    if (row.state === "approved" && row.provider_tombstone_sequence !== null
      && row.provider_tombstone_set_root !== null) {
      return { sequence: row.provider_tombstone_sequence,
        set_root: row.provider_tombstone_set_root };
    }
    const status = await this.options.provider.generationStatus();
    if (status.kind !== "data" || typeof status.value.tombstone_sequence !== "number"
      || typeof status.value.tombstone_set_root !== "string") {
      throw new JarvisError("MEMORY_CORRECTION_PROVIDER_STALE");
    }
    return { sequence: status.value.tombstone_sequence,
      set_root: status.value.tombstone_set_root };
  }
}
