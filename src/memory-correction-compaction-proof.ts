import { controlValueDigest as hash } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import { invalidCorrectionControl as invalid, type CorrectionControlRow } from "./memory-correction-control-binding.js";

/** Reuse a completed purge after a crash; never repeat physical compaction. */
export function correctionCompactionProof(authority: AuthorityDb, record: CorrectionControlRow, now: Date) {
  const purgeId = `mempurge:v2:${hash({ lane: "correction", lane_id: record.lane_id,
    target_manifest_digest: record.target_manifest_digest, scope_digest: record.scope_digest,
    tombstone: { sequence: record.tombstone_sequence, set_root: record.tombstone_set_root } }).slice(7)}`;
  const receipt = authority.db.prepare("SELECT * FROM memory_compaction_receipts WHERE purge_id=?")
    .get(purgeId) as Record<string, unknown> | undefined;
  if (receipt === undefined) return undefined;
  const body = { purge_id: purgeId, source_database_digest: receipt.source_database_digest,
    result_database_digest: receipt.result_database_digest, surface_manifest_digest: receipt.surface_manifest_digest,
    backup_disposal_digest: receipt.backup_disposal_digest, reader_drain_digest: receipt.reader_drain_digest,
    compacted_at: receipt.compacted_at };
  const digest = hash(body);
  const job = authority.db.prepare("SELECT * FROM memory_purge_jobs WHERE purge_id=?").get(purgeId) as Record<string, unknown>;
  const run = authority.db.prepare("SELECT * FROM memory_compaction_runs WHERE purge_id=?").get(purgeId) as Record<string, unknown>;
  const manifest = authority.db.prepare("SELECT * FROM memory_surface_catalog_manifests WHERE purge_id=?")
    .get(purgeId) as Record<string, unknown>;
  if (!job || !run || !manifest || receipt.receipt_digest !== digest
    || receipt.receipt_id !== `memcompact:v1:${digest.slice(7)}`
    || ["old_database_disposed", "wal_disposed", "shm_disposed", "journal_disposed"].some(key => receipt[key] !== 1)
    || job.lane !== "correction" || job.lane_id !== record.lane_id
    || job.target_manifest_digest !== record.target_manifest_digest || job.scope_digest !== record.scope_digest
    || job.tombstone_sequence !== record.tombstone_sequence || job.tombstone_set_root !== record.tombstone_set_root
    || job.state !== "completed" || job.compaction_receipt_digest !== digest
    || job.scan_errors !== 0 || job.plaintext_matches !== 0 || run.state !== "completed"
    || run.integrity_check !== "ok" || run.foreign_key_error_count !== 0 || run.swap_receipt_digest !== digest
    || run.reader_drain_digest !== receipt.reader_drain_digest
    || manifest.manifest_digest !== receipt.surface_manifest_digest || job.surface_manifest_digest !== manifest.manifest_digest
    || manifest.tombstone_sequence !== record.tombstone_sequence || manifest.tombstone_set_root !== record.tombstone_set_root
    || manifest.expected_surface_count !== 70 || manifest.observed_surface_count !== 70
    || manifest.omission_count !== 0 || manifest.error_count !== 0 || manifest.match_count !== 0
    || !Number.isFinite(Date.parse(String(receipt.compacted_at)))
    || Date.parse(String(receipt.compacted_at)) < Date.parse(record.dispatched_at)
    || Date.parse(String(receipt.compacted_at)) > now.getTime()
    || run.completed_at !== receipt.compacted_at || job.completed_at !== receipt.compacted_at) invalid();
  return { digest, compacted_at: String(receipt.compacted_at) };
}
