import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { MemoryCorrectionStore } from "./memory-correction-store.js";
import { requireUnsentCancellationEvidence } from "./memory-correction-cancellation-db.js";
import { cancellationCompactionRequest, type CancellationLocalCompaction } from "./memory-cancellation-compaction.js";

export type CancellationSettlement = {
  readonly correction_id: string; readonly purge_id: string; readonly result_digest: string;
  readonly local_receipt_digest: string; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly settled_at: string;
};

export function persistCancellationSettlement(authority: AuthorityDb, local: CancellationLocalCompaction,
  clock: () => Date): CancellationSettlement {
  return authority.db.transaction(() => {
    const request = cancellationCompactionRequest(authority, local.correction_id, clock);
    const receipt = authority.db.prepare("SELECT receipt_json FROM memory_cancellation_compaction_receipts WHERE purge_id=?")
      .get(local.purge_id) as { receipt_json: string } | undefined;
    if (request.cancellation.result_digest !== local.result_digest || receipt?.receipt_json !== canonicalize(local))
      throw new JarvisError("MEMORY_CANCELLATION_SETTLEMENT_INVALID");
    const expected = { correction_id: local.correction_id, purge_id: local.purge_id, result_digest: local.result_digest,
      local_receipt_digest: local.receipt_digest, tombstone_sequence: request.tombstone.sequence, tombstone_set_root: request.tombstone.set_root };
    const cursor = authority.db.prepare("SELECT active_lane_id,accepted_through_sequence FROM memory_effect_dispatch_cursor WHERE singleton_id=1")
      .get() as { active_lane_id: string | null; accepted_through_sequence: number };
    const prior = authority.db.prepare("SELECT * FROM memory_cancellation_settlements WHERE correction_id=?")
      .get(local.correction_id) as CancellationSettlement | undefined;
    if (prior) {
      if (canonicalize(prior) !== canonicalize({ ...expected, settled_at: prior.settled_at })
        || cursor.accepted_through_sequence < prior.tombstone_sequence) throw new JarvisError("MEMORY_CANCELLATION_SETTLEMENT_INVALID");
      return prior;
    }
    if (cursor.active_lane_id !== null || cursor.accepted_through_sequence !== request.tombstone.sequence - 1)
      throw new JarvisError("MEMORY_CANCELLATION_ORDER_BLOCKED");
    const correction = new MemoryCorrectionStore(authority).get(local.correction_id);
    if (!correction) throw new JarvisError("MEMORY_CANCELLATION_SETTLEMENT_INVALID");
    requireUnsentCancellationEvidence(authority, correction, clock());
    const result = { ...expected, settled_at: clock().toISOString() };
    authority.db.prepare("INSERT INTO memory_cancellation_settlements VALUES(?,?,?,?,?,?,?)")
      .run(...Object.values(result));
    const updated = authority.db.prepare(`UPDATE memory_effect_dispatch_cursor SET accepted_through_sequence=?,updated_at=?
      WHERE singleton_id=1 AND active_lane_id IS NULL AND accepted_through_sequence=?`)
      .run(result.tombstone_sequence, result.settled_at, result.tombstone_sequence-1);
    if (updated.changes !== 1) throw new JarvisError("MEMORY_CANCELLATION_ORDER_BLOCKED");
    return result;
  }).immediate();
}
