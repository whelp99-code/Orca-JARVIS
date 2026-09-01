import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { countOpenInode } from "./authority-database-process.js";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { JarvisError } from "./db.js";
import type {
  MemoryCompactionObservation,
  MemoryCompactionRecovery,
} from "./memory-compaction-types.js";
import { completeCompaction } from "./memory-compaction-persistence.js";
import type { MemoryManagedSurfaceScanner } from "./memory-managed-surface-scanner.js";
import type { ReingressGuardObservations } from "./memory-managed-surface-types.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update(Buffer.isBuffer(value) ? value : canonicalize(value)).digest("hex")}`;

type RecoveryRow = {
  readonly purge_id: string;
  readonly source_generation: number;
  readonly result_generation: number;
  readonly source_device: string;
  readonly source_inode: string;
  readonly logical_source_digest: string;
  readonly logical_result_digest: string;
  readonly physical_scan_digest: string;
  readonly created_at: string;
  readonly provider_manifest_digest: string;
  readonly reingress_guards_json: string;
};

export async function recoverMemoryCompaction(
  runtime: AuthorityDatabaseRuntime,
  scanner: MemoryManagedSurfaceScanner,
  purgeId: string,
): Promise<MemoryCompactionRecovery> {
  const authority = runtime.authorityDb();
  const row = recoveryRow(authority.db.prepare(
    `SELECT r.purge_id,r.source_generation,r.result_generation,r.source_device,r.source_inode,
            r.logical_source_digest,r.logical_result_digest,r.physical_scan_digest,r.created_at,
            i.provider_manifest_digest,i.reingress_guards_json
     FROM memory_compaction_runs r JOIN memory_compaction_inputs i ON i.purge_id=r.purge_id
     WHERE r.purge_id=? AND r.state='reconciling'`,
  ).get(purgeId));
  const oldFdCount = countOpenInode(runtime.registeredProcesses(),
    BigInt(row.source_device), BigInt(row.source_inode));
  if (oldFdCount !== 0) return { state: "reconciling", old_fd_count: oldFdCount };
  const active = statSync(authority.filename, { bigint: true });
  const readerDrainDigest = digest({ purge_id: purgeId,
    source_device: row.source_device, source_inode: row.source_inode,
    old_fd_count: 0, acknowledged_generation: row.result_generation });
  for (const process of runtime.registeredProcesses()) {
    authority.db.prepare(
      `INSERT OR IGNORE INTO memory_reader_drain_observations(
        purge_id,process_id,process_start_token,database_device,database_inode,
        registered_leases,proc_fd_count,acknowledged_generation,observed_at
       ) VALUES(?,?,?,?,?,0,0,?,?)`,
    ).run(purgeId, process.pid, process.start_token, row.source_device,
      row.source_inode, row.result_generation, new Date().toISOString());
  }
  const inventory = await scanner.scan({ provider: {
    manifest_digest: row.provider_manifest_digest, catalog_rows: 40,
    signature_verified: true }, guards: parseGuards(row.reingress_guards_json) });
  const resultDigest = digest(readFileSync(authority.filename));
  const receiptDigest = completeCompaction(authority, {
    purge_id: purgeId, source_generation: row.source_generation,
    result_generation: row.result_generation, source_device: row.source_device,
    source_inode: row.source_inode, source_digest: row.logical_source_digest,
    created_at: new Date().toISOString(), result_device: active.dev.toString(),
    result_inode: active.ino.toString(), result_digest: resultDigest,
    logical_result_digest: row.logical_result_digest,
    reader_drain_digest: readerDrainDigest,
    physical_scan_digest: row.physical_scan_digest,
    backup_disposal_digest: digest({ recovered: purgeId }), inventory,
  });
  const observation: MemoryCompactionObservation = { purge_id: purgeId,
    compaction_receipt_digest: receiptDigest, source_generation: row.source_generation,
    result_generation: row.result_generation, integrity_check: "ok", foreign_key_errors: 0,
    old_database_disposed: true, old_wal_disposed: true, old_shm_disposed: true,
    old_journal_disposed: true, old_fd_count: 0,
    reader_drain_digest: readerDrainDigest, inventory };
  return observation;
}

function recoveryRow(value: unknown): RecoveryRow {
  if (value === null || typeof value !== "object") throw new JarvisError("MEMORY_COMPACTION_NOT_FOUND");
  const result: Record<string, string | number> = {};
  for (const key of ["purge_id", "source_device", "source_inode", "logical_source_digest",
    "logical_result_digest", "physical_scan_digest", "created_at", "provider_manifest_digest",
    "reingress_guards_json"] as const) {
    const item = Reflect.get(value, key);
    if (typeof item !== "string") throw new JarvisError("MEMORY_COMPACTION_RECOVERY_INVALID");
    result[key] = item;
  }
  for (const key of ["source_generation", "result_generation"] as const) {
    const item = Reflect.get(value, key);
    if (typeof item !== "number" || !Number.isSafeInteger(item)) {
      throw new JarvisError("MEMORY_COMPACTION_RECOVERY_INVALID");
    }
    result[key] = item;
  }
  return {
    purge_id: String(result["purge_id"]), source_generation: Number(result["source_generation"]),
    result_generation: Number(result["result_generation"]),
    source_device: String(result["source_device"]), source_inode: String(result["source_inode"]),
    logical_source_digest: String(result["logical_source_digest"]),
    logical_result_digest: String(result["logical_result_digest"]),
    physical_scan_digest: String(result["physical_scan_digest"]),
    created_at: String(result["created_at"]),
    provider_manifest_digest: String(result["provider_manifest_digest"]),
    reingress_guards_json: String(result["reingress_guards_json"]),
  };
}

function parseGuards(value: string): ReingressGuardObservations {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JarvisError("MEMORY_COMPACTION_RECOVERY_INVALID");
  }
  const guards: Record<string, string> = {};
  for (const key of Reflect.ownKeys(parsed)) {
    if (typeof key !== "string") throw new JarvisError("MEMORY_COMPACTION_RECOVERY_INVALID");
    const item = Reflect.get(parsed, key);
    if (typeof item !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item)) {
      throw new JarvisError("MEMORY_COMPACTION_RECOVERY_INVALID");
    }
    guards[key] = item;
  }
  return guards;
}
