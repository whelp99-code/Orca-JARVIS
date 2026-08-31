import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { MemoryTombstoneChain, type AppendMemoryTombstoneInput } from "./memory-tombstone-chain.js";
import {
  MEMORY_TOMBSTONE_GENESIS_ROOT,
  type MemoryTombstoneChainEntryV2,
  type MemoryTombstoneHighWaterV2,
} from "./second-brain-effect-v2.js";

export type PreparedEffectRequest = {
  readonly request_id: string;
  readonly request_digest: string;
  readonly envelope_digest: string;
  readonly idempotency_key: string;
  readonly delegation: {
    readonly delegation_id: string;
    readonly delegation_digest: string;
  };
};

export type DestructiveRequestBuildInput = {
  readonly high_water: MemoryTombstoneHighWaterV2;
  readonly chain_delta: readonly MemoryTombstoneChainEntryV2[];
};

export type PrepareDestructiveEffectInput<Request extends PreparedEffectRequest> = {
  readonly lane_id: string;
  readonly provider_high_water: MemoryTombstoneHighWaterV2;
  readonly tombstone: AppendMemoryTombstoneInput;
  readonly build_request: (input: DestructiveRequestBuildInput) => Request;
  readonly materialize: (request: Request, sequence: number) => void;
};

export type PreparedDestructiveEffect<Request extends PreparedEffectRequest> = {
  readonly entry: MemoryTombstoneChainEntryV2;
  readonly entry_request_high_water: MemoryTombstoneHighWaterV2;
  readonly current_global_high_water: MemoryTombstoneHighWaterV2;
  readonly request: Request;
  readonly replayed: boolean;
};

type PreparationRow = {
  readonly lane_id: string;
  readonly state: string;
  readonly provider_tombstone_sequence: number | null;
  readonly provider_tombstone_set_root: string | null;
  readonly request_id: string | null;
  readonly request_digest: string | null;
  readonly envelope_digest: string | null;
  readonly provider_idempotency_key: string | null;
  readonly delegation_id: string | null;
  readonly delegation_digest: string | null;
};

export class MemoryDestructivePreparationStore {
  private readonly chain: MemoryTombstoneChain;

  constructor(
    private readonly authority: AuthorityDb,
    subjectKey: Buffer,
  ) {
    this.chain = new MemoryTombstoneChain(authority, subjectKey);
  }

  prepare<Request extends PreparedEffectRequest>(
    input: PrepareDestructiveEffectInput<Request>,
  ): PreparedDestructiveEffect<Request> {
    if (input.lane_id !== input.tombstone.lane_id) {
      throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_INVALID");
    }
    return this.authority.db.transaction(() => {
      const before = this.preparation(input.lane_id);
      const providerHighWater = before.state === "approved"
        ? this.storedProviderHighWater(before)
        : input.provider_high_water;
      this.assertPrefix(providerHighWater);
      const appended = this.chain.append(input.tombstone);
      const entryHighWater = appended.entry_request_high_water;
      const request = input.build_request({ high_water: entryHighWater,
        chain_delta: this.deltaThrough(providerHighWater.sequence, appended.entry.sequence) });
      if (before.state === "approved") {
        this.assertReplay(before, request);
        return { entry: appended.entry, entry_request_high_water: entryHighWater,
          current_global_high_water: appended.current_global_high_water,
          request, replayed: true };
      }
      if (before.state !== "staged") {
        throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_INVALID");
      }
      const changed = this.authority.db.prepare(
        `UPDATE memory_effect_preparations SET state='approved',effective_at=?,
         provider_tombstone_sequence=?,provider_tombstone_set_root=?,
         request_tombstone_sequence=?,request_tombstone_set_root=?,request_id=?,request_digest=?,
         envelope_digest=?,provider_idempotency_key=?,delegation_id=?,delegation_digest=?,
         prepared_at=?,updated_at=? WHERE lane_id=? AND state='staged'`,
      ).run(appended.entry.effective_at, providerHighWater.sequence, providerHighWater.set_root,
        entryHighWater.sequence, entryHighWater.set_root, request.request_id,
        request.request_digest, request.envelope_digest, request.idempotency_key,
        request.delegation.delegation_id, request.delegation.delegation_digest,
        appended.entry.effective_at, appended.entry.effective_at, input.lane_id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_RACE");
      this.chain.link(appended.entry.sequence, request.delegation.delegation_digest,
        request.request_digest, new Date(appended.entry.effective_at));
      input.materialize(request, appended.entry.sequence);
      return { entry: appended.entry, entry_request_high_water: entryHighWater,
        current_global_high_water: appended.current_global_high_water,
        request, replayed: false };
    }).immediate();
  }

  private assertPrefix(highWater: MemoryTombstoneHighWaterV2): void {
    if (highWater.sequence === 0) {
      if (highWater.set_root !== MEMORY_TOMBSTONE_GENESIS_ROOT) {
        throw new JarvisError("MEMORY_TOMBSTONE_PROVIDER_PREFIX_INVALID");
      }
      return;
    }
    const row = this.authority.db.prepare(
      "SELECT set_root FROM memory_tombstone_chain WHERE sequence=?",
    ).get(highWater.sequence) as { readonly set_root: string } | undefined;
    if (row?.set_root !== highWater.set_root) {
      throw new JarvisError("MEMORY_TOMBSTONE_PROVIDER_PREFIX_INVALID");
    }
  }

  private assertReplay(row: PreparationRow, request: PreparedEffectRequest): void {
    if (row.request_id !== request.request_id || row.request_digest !== request.request_digest
      || row.envelope_digest !== request.envelope_digest
      || row.provider_idempotency_key !== request.idempotency_key
      || row.delegation_id !== request.delegation.delegation_id
      || row.delegation_digest !== request.delegation.delegation_digest) {
      throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_REPLAY_CONFLICT");
    }
  }

  private deltaThrough(after: number, through: number): readonly MemoryTombstoneChainEntryV2[] {
    const delta = this.chain.delta(after).filter(entry => entry.sequence <= through);
    if (delta.length === 0 || delta.at(-1)?.sequence !== through) {
      throw new JarvisError("MEMORY_TOMBSTONE_DELTA_INVALID");
    }
    return delta;
  }

  private storedProviderHighWater(row: PreparationRow): MemoryTombstoneHighWaterV2 {
    if (row.provider_tombstone_sequence === null || row.provider_tombstone_set_root === null) {
      throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_INVALID");
    }
    return { sequence: row.provider_tombstone_sequence,
      set_root: row.provider_tombstone_set_root };
  }

  private preparation(laneId: string): PreparationRow {
    const row = this.authority.db.prepare(
      `SELECT lane_id,state,provider_tombstone_sequence,provider_tombstone_set_root,
       request_id,request_digest,envelope_digest,provider_idempotency_key,delegation_id,
       delegation_digest FROM memory_effect_preparations WHERE lane_id=?`,
    ).get(laneId) as PreparationRow | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_NOT_FOUND");
    return row;
  }
}
