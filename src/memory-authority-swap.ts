import { createHash } from "node:crypto";
import { closeSync, lstatSync, linkSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { JarvisError as AuthorityError } from "./db.js";
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export type SwapRequest = {
  readonly cancellation?: boolean;
  readonly fresh_path: string;
  readonly old_device: bigint;
  readonly old_inode: bigint;
  readonly purge_id: string;
  readonly result_generation: number;
  readonly logical_result_digest: string;
  readonly physical_scan_digest: string;
  readonly observed_at: string;
};

export type SwapObservation = {
  readonly result_device: string;
  readonly result_inode: string;
  readonly old_fd_count: 0;
  readonly reader_drain_digest: string;
};

/** Caller holds the runtime quiesce lease for the complete compaction. */
export async function swapAuthorityDatabase(runtime: AuthorityDatabaseRuntime, input: SwapRequest): Promise<SwapObservation> {
    const authority = runtime.authorityDb();
    authority.db.pragma("wal_checkpoint(TRUNCATE)");
    authority.close();
    removeSidecars(authority.filename);
    if (input.cancellation) {
      const source = lstatSync(authority.filename, { bigint: true });
      if (!source.isFile() || source.nlink !== 1n || source.dev !== input.old_device || source.ino !== input.old_inode) {
        authority.reopen();
        throw new AuthorityError("MEMORY_CANCELLATION_RETIRED_SOURCE_INVALID");
      }
      try {
        linkSync(authority.filename, retiredSourcePath(authority.filename, input.purge_id));
        syncPath(dirname(authority.filename), true);
      } catch (error) { authority.reopen(); throw error; }
    }
    const oldInode = (() => {
      try {
        renameSync(input.fresh_path, authority.filename);
        syncPath(dirname(authority.filename), true);
        return runtime.observeOldInode(input.old_device, input.old_inode);
      } catch (error) {
        authority.reopen();
        throw error;
      }
    })();
    authority.reopen();
    runtime.acknowledgeGeneration(input.result_generation);
    const active = statSync(authority.filename, { bigint: true });
    const oldFdCount = oldInode.fd_count;
    authority.db.prepare(
      `UPDATE memory_compaction_runs SET state='draining',result_device=?,result_inode=?,
       logical_result_digest=?,integrity_check='ok',foreign_key_error_count=0,
       physical_scan_digest=?,updated_at=? WHERE purge_id=?`,
    ).run(active.dev.toString(), active.ino.toString(), input.logical_result_digest,
      input.physical_scan_digest, input.observed_at, input.purge_id);
    const drainDigest = digest({ purge_id: input.purge_id,
      source_device: input.old_device.toString(), source_inode: input.old_inode.toString(),
      old_fd_count: oldFdCount, holders: oldInode.holders,
      acknowledged_generation: input.result_generation });
    if (oldFdCount !== 0) throw new AuthorityError("MEMORY_OLD_DATABASE_FD_ACTIVE");
    for (const process of runtime.registeredProcesses()) {
      authority.db.prepare(
        `INSERT INTO memory_reader_drain_observations(
          purge_id,process_id,process_start_token,database_device,database_inode,
          registered_leases,proc_fd_count,acknowledged_generation,observed_at
         ) VALUES(?,?,?,?,?,0,?,?,?)`,
      ).run(input.purge_id, process.pid, process.start_token,
        input.old_device.toString(), input.old_inode.toString(), oldFdCount,
        input.result_generation, input.observed_at);
    }
    authority.db.prepare("UPDATE memory_compaction_runs SET reader_drain_digest=? WHERE purge_id=?")
      .run(drainDigest, input.purge_id);
    if (input.cancellation) removeRetiredSource(authority.filename, input.purge_id,
      input.old_device.toString(), input.old_inode.toString());
    return { result_device: active.dev.toString(), result_inode: active.ino.toString(),
      old_fd_count: 0, reader_drain_digest: drainDigest };
  }

function removeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

export function syncPath(path: string, directory = false): void {
  const descriptor = openSync(path, directory ? "r" : "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function retiredSourcePath(databasePath: string, purgeId: string): string {
  return join(dirname(databasePath), `.${basename(databasePath)}.${digest(purgeId).slice(7, 31)}.retired`);
}

export function removeRetiredSource(databasePath: string, purgeId: string, device: string, inode: string): void {
  const path = retiredSourcePath(databasePath, purgeId);
  let metadata;
  try { metadata = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile() || metadata.dev.toString() !== device || metadata.ino.toString() !== inode
    || metadata.nlink < 1n || metadata.nlink > 2n) throw new AuthorityError("MEMORY_CANCELLATION_RETIRED_SOURCE_INVALID");
  rmSync(path);
  syncPath(dirname(databasePath), true);
}
