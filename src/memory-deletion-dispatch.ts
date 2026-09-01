import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { JarvisError } from "./db.js";
import { MemoryDeletionStore, type MemoryDeletionRecord } from "./memory-deletion-store.js";
import type { MemoryDeletionSagaOptions } from "./memory-deletion-types.js";
import { MemoryDestructiveDispatchCursor } from "./memory-destructive-dispatch.js";
import { MemoryDestructivePreparationStore } from "./memory-destructive-preparation.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { bindStructuredProjection } from "./memory-projection-bindings.js";
import { publishMemorySuppression } from "./memory-suppression-events.js";
import {
  MemoryDeletionPayloadSchema,
  MemoryEffectScopeSchema,
  ResolvedMemoryTargetSchema,
} from "./memory-effect-write-zod.js";
import { memoryExpectedPrior } from "./memory-target-values.js";
import {
  createMemoryEffectWriteRequest,
  parseMemoryEffectAccepted,
  type MemoryDeletePayloadV2,
  type MemoryEffectScopeV2,
  type MemoryEffectWriteRequestV2,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";
import type { SecondBrainWriteOutcome } from "./second-brain-adapter-types.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
const deletionSpool = z.object({
  schema_version: z.literal(1), lane_id: z.string(), deletion_id: z.string(),
  provider_instance_id: z.string(), targets: z.array(ResolvedMemoryTargetSchema).min(1).max(64),
  scope: MemoryEffectScopeSchema, payload: MemoryDeletionPayloadSchema,
  created_at: z.string(), expires_at: z.string(), nonce: z.string(),
}).strict();

type PreparationRow = {
  readonly spool_locator: string;
  readonly spool_digest: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly payload_digest: string;
  readonly state: string;
  readonly provider_tombstone_sequence: number | null;
  readonly provider_tombstone_set_root: string | null;
};

export class MemoryDeletionDispatcher {
  private readonly store: MemoryDeletionStore;
  private readonly spool: MemoryEffectSpool;
  private readonly preparations: MemoryDestructivePreparationStore;
  private readonly cursor: MemoryDestructiveDispatchCursor;

  constructor(private readonly options: MemoryDeletionSagaOptions) {
    this.store = new MemoryDeletionStore(options.authority);
    this.spool = new MemoryEffectSpool(options.spool_root, options.authority);
    this.preparations = new MemoryDestructivePreparationStore(options.authority, options.subject_key);
    this.cursor = new MemoryDestructiveDispatchCursor(options.authority);
  }

  async dispatch(command: ClaimedControlCommand): Promise<MemoryDeletionRecord> {
    const now = this.options.clock();
    const { id, laneId, preparation, row } = this.authorized(command);
    if (preparation.state === "approved" && row.state !== "queued" && row.state !== "requested") return row;
    const parsed = deletionSpool.safeParse(
      await this.spool.read(preparation.spool_locator, preparation.spool_digest),
    );
    if (!parsed.success) throw new JarvisError("MEMORY_DELETION_SPOOL_INVALID");
    const targets: ResolvedMemoryTargetV2[] = parsed.data.targets;
    const scope: MemoryEffectScopeV2 = parsed.data.scope;
    const payload: MemoryDeletePayloadV2 = parsed.data.payload;
    const receipt = this.options.authority.db.prepare(
      "SELECT payload_json,signature FROM control_command_receipts WHERE receipt_id=? AND request_id=?",
    ).get(command.receipt_id, command.request_id) as {
      readonly payload_json: string; readonly signature: string;
    } | undefined;
    if (receipt === undefined) throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    const firstTarget = targets[0];
    if (firstTarget === undefined) throw new JarvisError("MEMORY_DELETION_TARGET_MISSING");
    const prepared = this.preparations.prepare({ lane_id: laneId,
      provider_high_water: await this.providerHighWater(preparation),
      tombstone: { operation: "forget", lane_id: laneId, targets,
        target_manifest_digest: row.target_manifest_digest, scope_digest: row.scope_digest,
        authority_receipt_digest: hash("orca-jarvis/memory-delete-receipt/v1\0", receipt),
        payload_digest: row.payload_digest, effective_at: now.toISOString() },
      build_request: value => createMemoryEffectWriteRequest({ schema_version: 2,
        kind: "memory_effect", provider_instance_id: parsed.data.provider_instance_id,
        lane: "deletion", lane_id: laneId, operation: "forget",
        target_manifest_digest: row.target_manifest_digest, targets, scope,
        scope_digest: row.scope_digest, expected_prior: memoryExpectedPrior(firstTarget),
        tombstone_high_water: value.high_water, tombstone_chain_delta: value.chain_delta,
        created_at: parsed.data.created_at, expires_at: parsed.data.expires_at, payload,
      }, { principal_id: "principal:owner", not_before: parsed.data.created_at,
        nonce: parsed.data.nonce, signing_key_id: this.options.signing_key_id },
      this.options.private_key),
      materialize: request => {
        bindStructuredProjection(this.options.authority.db, { kind: "control_payload",
          id: command.request_id, component_id: command.request_id }, request, now);
        this.store.approve(id, { lane_id: laneId,
          provider_instance_id: parsed.data.provider_instance_id,
          control_request_id: command.request_id, control_receipt_id: command.receipt_id,
          control_command_digest: command.command_digest }, now);
        this.store.suppress(id, request.tombstone_high_water.sequence,
          request.tombstone_high_water.set_root, now);
        this.store.queue(id, { request_id: request.request_id,
          request_digest: request.request_digest, envelope_digest: request.envelope_digest,
          provider_idempotency_key: request.idempotency_key,
          delegation_id: request.delegation.delegation_id,
          delegation_digest: request.delegation.delegation_digest,
          spool_locator: preparation.spool_locator }, now);
      },
    });
    await this.options.barriers.reach({ barrier_id: "jarvis_suppression_tombstone_commit",
      lane_id: laneId, request_id: prepared.request.request_id,
      tombstone_sequence: prepared.entry.sequence, now });
    publishMemorySuppression(this.options.authority, prepared.entry.sequence, now);
    const current = this.store.get(id);
    if (current === undefined) throw new JarvisError("MEMORY_DELETION_NOT_FOUND");
    if (current.state !== "queued") return current;
    const claim = this.cursor.claim({ lane_id: laneId, lane: "deletion",
      sequence: prepared.entry.sequence, request_digest: prepared.request.request_digest }, now);
    if (claim.kind === "reconcile") return current;
    const applying = this.store.begin(id, now);
    const outcome = await this.options.writer.write(prepared.request);
    await this.recordOutcome(applying, prepared.request, outcome, now);
    if (outcome.kind === "accepted" && outcome.schema_version === 2) this.cursor.accepted(laneId, now);
    return this.store.get(id) ?? applying;
  }

  private authorized(command: ClaimedControlCommand): {
    readonly id: string; readonly laneId: string;
    readonly preparation: PreparationRow; readonly row: MemoryDeletionRecord;
  } {
    if (command.action !== "memory.delete" || command.action_level !== 3
      || command.args.schema_version !== 3 || command.args.lane !== "deletion"
      || typeof command.target.deletion_id !== "string" || typeof command.args.lane_id !== "string") {
      throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    }
    const row = this.store.get(command.target.deletion_id);
    const preparation = this.options.authority.db.prepare(
      "SELECT * FROM memory_effect_preparations WHERE lane_id=? AND lane='deletion'",
    ).get(command.args.lane_id) as PreparationRow | undefined;
    if (preparation === undefined || !["staged", "approved"].includes(preparation.state)
      || row === undefined || preparation.spool_digest !== command.args.spool_digest
      || row.target_manifest_digest !== command.args.target_manifest_digest
      || row.scope_digest !== command.args.scope_digest) {
      throw new JarvisError("MEMORY_DELETION_AUTHORITY_INVALID");
    }
    return { id: command.target.deletion_id, laneId: command.args.lane_id,
      preparation, row };
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
      throw new JarvisError("MEMORY_DELETION_PROVIDER_STALE");
    }
    return { sequence: status.value.tombstone_sequence,
      set_root: status.value.tombstone_set_root };
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
      await this.spool.remove(row.lane_id, row.spool_locator, row.spool_digest,
        "accepted", now);
      this.store.accepted(row.deletion_id, accepted, accepted.queue_locator, now);
      return;
    }
    this.store.uncertain(row.deletion_id,
      "code" in outcome ? outcome.code : "MEMORY_DELETION_UNCERTAIN", now);
  }
}
