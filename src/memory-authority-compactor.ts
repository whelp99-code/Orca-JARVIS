import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { JarvisError as AuthorityError } from "./db.js";
import { buildFreshAuthority } from "./memory-authority-fresh-builder.js";
import { persistForbiddenContentIdentities } from "./memory-forbidden-content.js";
import { restoreBlockedProjections } from "./memory-restore-authority.js";
import { collectSuppressedContent } from "./memory-compaction-sanitize.js";
import type {
  MemoryAuthorityCompactorPort,
  MemoryCompactionObservation,
  MemoryCompactionRecovery,
  MemoryCompactionRequest,
} from "./memory-compaction-types.js";
import { recoverMemoryCompaction } from "./memory-compaction-recovery.js";
import {
  countManagedMatches,
  disposeSensitiveManagedCopies,
} from "./memory-compaction-external.js";
import {
  beginCompaction,
  completeCompaction,
  type CompactionStart,
} from "./memory-compaction-persistence.js";
import type {
  MemoryManagedSurfaceScanner,
  MemoryRuntimeLayout,
} from "./memory-managed-surface-scanner.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update(canonicalize(value)).digest("hex")}`;

type CompactorOptions = {
  readonly runtime: AuthorityDatabaseRuntime;
  readonly scanner: MemoryManagedSurfaceScanner;
  readonly layout: MemoryRuntimeLayout;
};

type SwapRequest = {
  readonly fresh_path: string;
  readonly old_device: bigint;
  readonly old_inode: bigint;
  readonly purge_id: string;
  readonly result_generation: number;
  readonly logical_result_digest: string;
  readonly physical_scan_digest: string;
  readonly observed_at: string;
};

type SwapObservation = {
  readonly result_device: string;
  readonly result_inode: string;
  readonly old_fd_count: 0;
  readonly reader_drain_digest: string;
};

export class MemoryAuthorityCompactor implements MemoryAuthorityCompactorPort {
  constructor(private readonly options: CompactorOptions) {}

  async compact(request: MemoryCompactionRequest): Promise<MemoryCompactionObservation> {
    this.assertRequest(request);
    const authority = this.options.runtime.authorityDb();
    const sourceMetadata = statSync(authority.filename, { bigint: true });
    const sourceGeneration = this.options.runtime.activeGeneration().generation;
    const purgeDigest = digest({ lane: request.lane, lane_id: request.lane_id,
      target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
      tombstone: request.tombstone });
    const purgeId = `mempurge:v2:${purgeDigest.slice(7)}`;
    const createdAt = new Date().toISOString();
    const start: CompactionStart = { purge_id: purgeId,
      source_generation: sourceGeneration, result_generation: sourceGeneration + 1,
      source_device: sourceMetadata.dev.toString(), source_inode: sourceMetadata.ino.toString(),
      source_digest: digest(readFileSync(authority.filename)), created_at: createdAt };
    beginCompaction(authority, request, start);
    const freshPath = join(dirname(authority.filename),
      `.${basename(authority.filename)}.${purgeDigest.slice(7, 23)}.fresh`);
    let sensitive: readonly Buffer[] = [];
    try {
      const blocked = restoreBlockedProjections(authority, authority);
      sensitive = collectSuppressedContent(authority.db, blocked);
      persistForbiddenContentIdentities(authority, { purge_id: purgeId,
        material: sensitive, observed_at: createdAt });
      const build = await buildFreshAuthority(authority, freshPath,
        { blocked_projections: blocked, sensitive_material: sensitive });
      syncPath(freshPath);
      syncPath(dirname(freshPath), true);
      const freshMetadata = statSync(freshPath, { bigint: true });
      if (freshMetadata.dev !== sourceMetadata.dev || freshMetadata.ino === sourceMetadata.ino) {
        throw new AuthorityError("MEMORY_COMPACTION_FILESYSTEM_INVALID");
      }
      const disposed = disposeSensitiveManagedCopies(this.options.layout, sensitive);
      if (countManagedMatches(this.options.layout, sensitive) !== 0) {
        throw new AuthorityError("MEMORY_COMPACTION_MANAGED_MATCH");
      }
      const swap = await this.swap({ fresh_path: freshPath,
        old_device: sourceMetadata.dev, old_inode: sourceMetadata.ino, purge_id: purgeId,
        result_generation: build.result_generation,
        logical_result_digest: build.logical_result_digest,
        physical_scan_digest: build.result_digest, observed_at: createdAt });
      const inventory = await this.options.scanner.scan({
        provider: request.provider_inventory, guards: request.reingress_guards,
      });
      const backupDisposalDigest = digest({ disposed_files: disposed,
        tombstone_sequence: request.tombstone.sequence });
      const receiptDigest = completeCompaction(authority, { ...start,
        result_device: swap.result_device, result_inode: swap.result_inode,
        result_digest: build.result_digest, logical_result_digest: build.logical_result_digest,
        reader_drain_digest: swap.reader_drain_digest,
        physical_scan_digest: build.result_digest,
        backup_disposal_digest: backupDisposalDigest, inventory });
      return { purge_id: purgeId, compaction_receipt_digest: receiptDigest,
        source_generation: build.source_generation, result_generation: build.result_generation,
        integrity_check: build.integrity_check, foreign_key_errors: build.foreign_key_errors,
        old_database_disposed: true, old_wal_disposed: true, old_shm_disposed: true,
        old_journal_disposed: true, old_fd_count: swap.old_fd_count,
        reader_drain_digest: swap.reader_drain_digest, inventory };
    } catch (error) {
      this.reconcileFailure(purgeId, error);
      rmSync(freshPath, { force: true });
      throw error;
    } finally {
      for (const value of sensitive) value.fill(0);
    }
  }

  recover(purgeId: string): Promise<MemoryCompactionRecovery> {
    return recoverMemoryCompaction(this.options.runtime, this.options.scanner, purgeId);
  }

  private async swap(input: SwapRequest): Promise<SwapObservation> {
    return this.options.runtime.quiesce("memory_compaction", async lease => {
      const authority = lease.authority;
      authority.db.pragma("wal_checkpoint(TRUNCATE)");
      authority.close();
      removeSidecars(authority.filename);
      try {
        renameSync(input.fresh_path, authority.filename);
        syncPath(dirname(authority.filename), true);
      } catch (error) {
        authority.reopen();
        throw error;
      }
      authority.reopen();
      this.options.runtime.acknowledgeGeneration(input.result_generation);
      const active = statSync(authority.filename, { bigint: true });
      const oldInode = this.options.runtime.observeOldInode(input.old_device, input.old_inode);
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
      for (const process of this.options.runtime.registeredProcesses()) {
        authority.db.prepare(
          `INSERT INTO memory_reader_drain_observations(
            purge_id,process_id,process_start_token,database_device,database_inode,
            registered_leases,proc_fd_count,acknowledged_generation,observed_at
           ) VALUES(?,?,?,?,?,0,?,?,?)`,
        ).run(input.purge_id, process.pid, process.start_token,
          input.old_device.toString(), input.old_inode.toString(), oldFdCount,
          input.result_generation, input.observed_at);
      }
      return { result_device: active.dev.toString(), result_inode: active.ino.toString(),
        old_fd_count: 0, reader_drain_digest: drainDigest };
    });
  }

  private assertRequest(request: MemoryCompactionRequest): void {
    const authority = this.options.runtime.authorityDb();
    const row = authority.db.prepare(
      `SELECT operation,target_manifest_digest,scope_digest,set_root
       FROM memory_tombstone_chain WHERE sequence=?`,
    ).get(request.tombstone.sequence);
    if (row === undefined || row === null || typeof row !== "object"
      || Reflect.get(row, "operation") !== (request.lane === "correction" ? "correct" : "forget")
      || Reflect.get(row, "target_manifest_digest") !== request.target_manifest_digest
      || Reflect.get(row, "scope_digest") !== request.scope_digest
      || Reflect.get(row, "set_root") !== request.tombstone.set_root) {
      throw new AuthorityError("MEMORY_COMPACTION_AUTHORITY_INVALID");
    }
  }

  private reconcileFailure(purgeId: string, error: unknown): void {
    const authority = this.options.runtime.authorityDb();
    if (!authority.db.open) return;
    const code = error instanceof AuthorityError ? error.code : "MEMORY_COMPACTION_FAILED";
    authority.db.prepare(
      `UPDATE memory_compaction_runs SET state='reconciling',failure_code=?,updated_at=?
       WHERE purge_id=? AND state<>'completed'`,
    ).run(code, new Date().toISOString(), purgeId);
    authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='reconciling',lease_owner=NULL,
       lease_expires_at=NULL,updated_at=? WHERE purge_id=? AND state IN ('compacting','verifying')`,
    ).run(new Date().toISOString(), purgeId);
  }
}

function removeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function syncPath(path: string, directory = false): void {
  const descriptor = openSync(path, directory ? "r" : "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
