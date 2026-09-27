import { z } from "zod";
import type { MemoryCompactionRequest } from "./memory-compaction-types.js";
import type { MemorySagaRuntime } from "./memory-saga-runtime.js";

/** A durable purge job owns the physical operation, including after the authority inode changes. */
export async function recoverOrCompactMemory(runtime: MemorySagaRuntime,
  request: MemoryCompactionRequest): Promise<string | undefined> {
  const row = runtime.authority.db.prepare(
    `SELECT purge_id FROM memory_purge_jobs WHERE lane=? AND lane_id=?
     AND target_manifest_digest=? AND scope_digest=? AND tombstone_sequence=? AND tombstone_set_root=?`,
  ).get(request.lane, request.lane_id, request.target_manifest_digest, request.scope_digest,
    request.tombstone.sequence, request.tombstone.set_root);
  const result = row === undefined ? await runtime.compactor.compact(request)
    : await runtime.compactor.recover(z.object({ purge_id: z.string() }).parse(row).purge_id);
  return "state" in result ? undefined : result.compaction_receipt_digest;
}
