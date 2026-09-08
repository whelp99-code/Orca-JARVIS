import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { MemoryCorrectionCancellationResultStore } from "./memory-correction-cancellation-result-store.js";
import { beginCompactionRun, type CompactionStart } from "./memory-compaction-persistence.js";
import type { MemoryCompactionRequest } from "./memory-compaction-types.js";
import type { JarvisLocalSurfaceObservation, MemoryRuntimeLayout } from "./memory-managed-surface-scanner.js";

export type CancellationCompactionRequest = Pick<MemoryCompactionRequest,
  "lane" | "lane_id" | "target_manifest_digest" | "scope_digest" | "tombstone"> & {
  readonly cancellation: { readonly correction_id: string; readonly result_digest: string };
};
export type CancellationLocalCompaction = {
  readonly schema_version: 1;
  readonly scope: "jarvis_cancellation_local_compaction";
  readonly purge_id: string;
  readonly correction_id: string;
  readonly result_digest: string;
  readonly result_generation: number;
  readonly result_device: string;
  readonly result_inode: string;
  readonly reader_drain_digest: string;
  readonly physical_scan_digest: string;
  readonly local: JarvisLocalSurfaceObservation;
  readonly observed_at: string;
  readonly receipt_digest: string;
};
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export function cancellationCompactionRequest(authority: AuthorityDb, correctionId: string,
  clock: () => Date): CancellationCompactionRequest {
  const result = new MemoryCorrectionCancellationResultStore(authority, clock).get(correctionId);
  if (!result) throw new JarvisError("MEMORY_CANCELLATION_RESULT_REQUIRED");
  return { lane: "correction", lane_id: result.original_lane_id,
    target_manifest_digest: result.target_manifest_digest, scope_digest: result.scope_digest,
    tombstone: { sequence: result.tombstone_sequence, set_root: result.tombstone_set_root },
    cancellation: { correction_id: correctionId, result_digest: result.result_digest } };
}

export function beginCancellationCompaction(authority: AuthorityDb, request: CancellationCompactionRequest,
  start: CompactionStart, layout: MemoryRuntimeLayout): void {
  authority.db.transaction(() => {
    beginCompactionRun(authority, request, start);
    authority.db.prepare("INSERT INTO memory_cancellation_compaction_inputs VALUES(?,?,?,?,?)")
      .run(start.purge_id, request.cancellation.correction_id, request.cancellation.result_digest,
        canonicalize(layout), start.created_at);
  }).immediate();
}

export function completeCancellationCompaction(authority: AuthorityDb, request: CancellationCompactionRequest,
  layout: MemoryRuntimeLayout, input: Omit<CancellationLocalCompaction,
    "schema_version" | "scope" | "correction_id" | "result_digest" | "receipt_digest">,
  clock: () => Date): CancellationLocalCompaction {
  return authority.db.transaction(() => {
    const current = cancellationCompactionRequest(authority, request.cancellation.correction_id, clock);
    const saved = authority.db.prepare("SELECT * FROM memory_cancellation_compaction_inputs WHERE purge_id=?")
      .get(input.purge_id) as { correction_id: string; result_digest: string; layout_json: string } | undefined;
    if (canonicalize(current) !== canonicalize(request) || !saved
      || saved.correction_id !== request.cancellation.correction_id || saved.result_digest !== request.cancellation.result_digest
      || saved.layout_json !== canonicalize(layout)) throw new JarvisError("MEMORY_CANCELLATION_COMPACTION_BINDING_INVALID");
    const material = authority.db.prepare("SELECT purge_id FROM memory_cancellation_material_checkpoints WHERE correction_id=?")
      .get(request.cancellation.correction_id) as { purge_id: string } | undefined;
    if (!material) throw new JarvisError("MEMORY_CANCELLATION_MATERIAL_UNPROVED");
    const prior = authority.db.prepare("SELECT receipt_json,receipt_digest FROM memory_cancellation_compaction_receipts WHERE purge_id=?")
      .get(input.purge_id) as { receipt_json: string; receipt_digest: string } | undefined;
    if (prior) {
      const receipt = JSON.parse(prior.receipt_json) as CancellationLocalCompaction;
      const { receipt_digest: recordedDigest, ...recorded } = receipt;
      if (canonicalize(receipt) !== prior.receipt_json || digest(recorded) !== recordedDigest || recordedDigest !== prior.receipt_digest
        || receipt.scope !== "jarvis_cancellation_local_compaction" || receipt.schema_version !== 1
        || receipt.correction_id !== request.cancellation.correction_id || receipt.result_digest !== request.cancellation.result_digest
        || receipt.purge_id !== input.purge_id || receipt.result_generation !== input.result_generation
        || receipt.result_device !== input.result_device || receipt.result_inode !== input.result_inode
        || receipt.reader_drain_digest !== input.reader_drain_digest || receipt.physical_scan_digest !== input.physical_scan_digest)
        throw new JarvisError("MEMORY_CANCELLATION_COMPACTION_BINDING_INVALID");
      return receipt;
    }
    const body = { schema_version: 1 as const, scope: "jarvis_cancellation_local_compaction" as const,
      ...request.cancellation, ...input };
    const receipt = { ...body, receipt_digest: digest(body) };
    authority.db.prepare("INSERT INTO memory_cancellation_compaction_receipts VALUES(?,?,?,?)")
      .run(input.purge_id, receipt.receipt_digest, canonicalize(receipt), input.observed_at);
    // Local verification is durable; the existing full lifecycle completion gate remains unspent.
    authority.db.prepare("UPDATE memory_purge_jobs SET state='verifying',updated_at=? WHERE purge_id=? AND state IN ('compacting','reconciling')")
      .run(input.observed_at, input.purge_id);
    return receipt;
  }).immediate();
}
