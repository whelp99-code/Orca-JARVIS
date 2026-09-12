import { createHash } from "node:crypto";
import { beginPublishPhase, endPublishPhase } from "./local-observation-retention-publish.js";
import { existsSync, closeSync, lstatSync, linkSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";
import { exclusionHole, discoverOpenInodeHolders } from "./authority-database-process.js";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { JarvisError as AuthorityError } from "./db.js";
import { publishSwapBarrier, releaseSwapBarrier } from "./authority-database-swap-barrier.js";
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
    // The same barrier the retention swap takes, so the two replacement paths exclude each other
    // and neither is joined by a connection opened after its critical section began. Taken while
    // this connection is still open, so there is no moment between closing and excluding. This
    // does not change what compaction tolerates: readers holding the retired inode are still
    // drained after the rename rather than refused before it.
    publishSwapBarrier(authority.filename, "memory_compaction", new Date(input.observed_at));
    // Readers holding the retired inode are still drained after the rename: a descriptor opened
    // read-only cannot lose a write, and that contract is what the existing acceptance proves. A
    // writer is a different thing - the rename would leave its commits in a file nothing reads
    // again - so a writer that is not this process refuses the replacement here, while the source
    // is still the live database and nothing has been closed, removed or moved.
    if (writableHolders(runtime, input.old_device, input.old_inode, true) !== 0) {
      releaseSwapBarrier(authority.filename);
      throw new AuthorityError("MEMORY_SOURCE_WRITER_ACTIVE");
    }
    authority.close();
    // Asked again with this connection gone, and this time without excusing anything for sharing a
    // pid: a second writable connection inside this process would be orphaned by the rename just
    // as surely as another process's, and the write-ahead log removed below would take its
    // committed rows with it. Readers are still left to the drain that follows the rename.
    if (writableHolders(runtime, input.old_device, input.old_inode, false) !== 0) {
      releaseSwapBarrier(authority.filename);
      authority.reopen();
      throw new AuthorityError("MEMORY_SOURCE_WRITER_ACTIVE");
    }
    // Same question, same place: before the log goes, not after.
    // Taken straight from the observer for the same reason writableHolders is: the runtime's
    // reading of the retired inode is a later, distinct step of this swap.
    const hole = exclusionHole(authority.filename,
      runtime.observeExclusion(input.old_device, input.old_inode));
    if (hole !== null) {
      releaseSwapBarrier(authority.filename);
      authority.reopen();
      throw new AuthorityError("MEMORY_EXCLUSION_UNPROVABLE", `MEMORY_EXCLUSION_UNPROVABLE: ${hole}`);
    }
    if (input.cancellation) {
      const source = lstatSync(authority.filename, { bigint: true });
      if (!source.isFile() || source.nlink !== 1n || source.dev !== input.old_device || source.ino !== input.old_inode) {
        releaseSwapBarrier(authority.filename);
        authority.reopen();
        throw new AuthorityError("MEMORY_CANCELLATION_RETIRED_SOURCE_INVALID");
      }
      try {
        linkSync(authority.filename, retiredSourcePath(authority.filename, input.purge_id));
        syncPath(dirname(authority.filename), true);
      } catch (error) { releaseSwapBarrier(authority.filename); authority.reopen(); throw error; }
    }
    // Retired rather than destroyed, on the same terms the retention swap settled on: the log is
    // not removed beside a connection that may still hold this inode, the inode keeps a name of
    // its own through a link taken before anything moves, and the phase is recorded so a fault
    // between the publish and the log's move can be settled on identity afterwards.
    const retiredDatabase = input.cancellation
      ? retiredSourcePath(authority.filename, input.purge_id)
      : `${authority.filename}.${input.purge_id}.retired`;
    const oldInode = (() => {
      try {
        // A cancellation already took its own retirement link; anything else takes one here, so
        // the inode keeps a name in both shapes of this swap rather than only one of them.
        if (!existsSync(retiredDatabase)) linkSync(authority.filename, retiredDatabase);
        const published = statSync(input.fresh_path, { bigint: true });
        beginPublishPhase(authority.filename, {
          operation_id: input.purge_id, retired_database: retiredDatabase,
          published: { device: published.dev.toString(), inode: published.ino.toString() },
          retired_identity: {
            device: input.old_device.toString(), inode: input.old_inode.toString() },
        });
        renameSync(input.fresh_path, authority.filename);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const sidecar = `${authority.filename}${suffix}`;
          if (existsSync(sidecar)) renameSync(sidecar, `${retiredDatabase}${suffix}`);
        }
        endPublishPhase(authority.filename);
        syncPath(dirname(authority.filename), true);
        return runtime.observeOldInode(input.old_device, input.old_inode);
      } catch (error) {
        releaseSwapBarrier(authority.filename);
        authority.reopen();
        throw error;
      }
    })();
    try {
      authority.reopen();
    } finally {
      releaseSwapBarrier(authority.filename);
    }
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

/**
 * Writers on the source that are not this process.
 *
 * This process's own connection is open when the question is asked and is closed a moment later
 * by the swap itself, in order; nobody else's is. The scan is taken straight from the observer
 * rather than through the runtime, because the runtime's own reading of the retired inode is a
 * distinct step of the swap that happens after the rename, and the two must not be one call.
 */
function writableHolders(
  runtime: AuthorityDatabaseRuntime, device: bigint, inode: bigint, excuseSelf: boolean,
): number {
  const writers = discoverOpenInodeHolders(device, inode, runtime.registeredProcesses())
    .writable_holders;
  return (excuseSelf ? writers.filter(holder => holder.pid !== process.pid) : writers).length;
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
