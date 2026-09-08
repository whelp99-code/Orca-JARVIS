import { cancellationCompactionRequest, beginCancellationCompaction, completeCancellationCompaction, sealCancellationSwap,
  type CancellationCompactionRequest, type CancellationLocalCompaction } from "./memory-cancellation-compaction.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
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
import { collectCancellationMaterial } from "./memory-cancellation-material.js";
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
  readonly clock?: () => Date;
};

type SwapRequest = {
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

type SwapObservation = {
  readonly result_device: string;
  readonly result_inode: string;
  readonly old_fd_count: 0;
  readonly reader_drain_digest: string;
};

export class MemoryAuthorityCompactor implements MemoryAuthorityCompactorPort {
  constructor(private readonly options: CompactorOptions) {}

  async compact(request: MemoryCompactionRequest): Promise<MemoryCompactionObservation> {
    return this.options.runtime.quiesce("memory_compaction", () => this.compactQuiesced(request));
  }

  compactCancellation(correctionId: string): Promise<CancellationLocalCompaction> {
    return this.options.runtime.quiesce("memory_compaction", () => this.compactQuiesced(
      cancellationCompactionRequest(this.options.runtime.authorityDb(), correctionId, this.options.clock ?? (() => new Date()))));
  }

  recoverCancellation(correctionId: string): Promise<CancellationLocalCompaction> {
    return this.options.runtime.quiesce("memory_compaction", async () => {
      const authority = this.options.runtime.authorityDb();
      const request = cancellationCompactionRequest(authority, correctionId, this.options.clock ?? (() => new Date()));
      const row = authority.db.prepare(`SELECT i.purge_id,r.source_device,r.source_inode,r.result_device,r.result_inode,
        r.source_generation,r.result_generation,r.physical_scan_digest,r.reader_drain_digest FROM memory_cancellation_compaction_inputs i
        JOIN memory_compaction_runs r ON r.purge_id=i.purge_id WHERE i.correction_id=?`).get(correctionId) as
        { purge_id: string; source_device: string; source_inode: string; result_device: string | null; result_inode: string | null;
          source_generation: number; result_generation: number; physical_scan_digest: string; reader_drain_digest: string | null } | undefined;
      const active = statSync(authority.filename, { bigint: true });
      if (row && row.result_device === null && row.result_inode === null
        && row.source_device === active.dev.toString() && row.source_inode === active.ino.toString()
        && row.source_generation === this.options.runtime.activeGeneration().generation) {
        removeRetiredSource(authority.filename, row.purge_id, row.source_device, row.source_inode);
        return this.compactQuiesced(request, true);
      }
      if (!row || row.result_device !== active.dev.toString() || row.result_inode !== active.ino.toString()
        || row.result_generation !== this.options.runtime.activeGeneration().generation)
        throw new AuthorityError("MEMORY_CANCELLATION_COMPACTION_NOT_SWAPPED");
      const drain = digest({ purge_id: row.purge_id, source_device: row.source_device, source_inode: row.source_inode,
        old_fd_count: 0, holders: [], acknowledged_generation: row.result_generation });
      if (row.reader_drain_digest !== drain || existsSync(retiredSourcePath(authority.filename, row.purge_id))) {
        const old = this.options.runtime.observeOldInode(BigInt(row.source_device), BigInt(row.source_inode));
        if (old.fd_count !== 0) throw new AuthorityError("MEMORY_OLD_DATABASE_FD_ACTIVE");
        if (old.holders.length !== 0) throw new AuthorityError("MEMORY_OLD_DATABASE_FD_ACTIVE");
      }
      authority.db.prepare("UPDATE memory_compaction_runs SET reader_drain_digest=? WHERE purge_id=?")
        .run(drain, row.purge_id);
      removeRetiredSource(authority.filename, row.purge_id, row.source_device, row.source_inode);
      const bytes = await collectCancellationMaterial(authority, this.options.layout.spool_root, row.purge_id,
        this.options.clock?.() ?? new Date());
      try { if (bytes.length !== 0) throw new AuthorityError("MEMORY_CANCELLATION_SPOOL_REAPPEARED"); }
      finally { bytes.forEach(value => value.fill(0)); }
      const local = this.options.scanner.scanLocal();
      return completeCancellationCompaction(authority, request, this.options.layout, {
        purge_id: row.purge_id, result_generation: row.result_generation, result_device: row.result_device,
        result_inode: row.result_inode, reader_drain_digest: drain, physical_scan_digest: row.physical_scan_digest,
        local, observed_at: (this.options.clock?.() ?? new Date()).toISOString(),
      }, this.options.clock ?? (() => new Date()));
    });
  }

  private compactQuiesced(request: MemoryCompactionRequest): Promise<MemoryCompactionObservation>;
  private compactQuiesced(request: CancellationCompactionRequest, resume?: boolean): Promise<CancellationLocalCompaction>;
  private async compactQuiesced(request: MemoryCompactionRequest | CancellationCompactionRequest, resume = false): Promise<MemoryCompactionObservation | CancellationLocalCompaction> {
    this.assertRequest(request);
    const authority = this.options.runtime.authorityDb();
    const sourceMetadata = statSync(authority.filename, { bigint: true });
    const sourceGeneration = this.options.runtime.activeGeneration().generation;
    const purgeDigest = digest({ lane: request.lane, lane_id: request.lane_id,
      target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
      tombstone: request.tombstone });
    const purgeId = `mempurge:v2:${purgeDigest.slice(7)}`;
    const createdAt = (this.options.clock?.() ?? new Date()).toISOString();
    const start: CompactionStart = { purge_id: purgeId,
      source_generation: sourceGeneration, result_generation: sourceGeneration + 1,
      source_device: sourceMetadata.dev.toString(), source_inode: sourceMetadata.ino.toString(),
      source_digest: digest(readFileSync(authority.filename)), created_at: createdAt };
    if ("cancellation" in request) beginCancellationCompaction(authority, request, start, this.options.layout, resume);
    else beginCompaction(authority, request, start);
    const freshPath = join(dirname(authority.filename),
      `.${basename(authority.filename)}.${purgeDigest.slice(7, 23)}.fresh`);
    let sensitive: readonly Buffer[] = [];
    try {
      const blocked = restoreBlockedProjections(authority, authority);
      sensitive = collectSuppressedContent(authority.db, blocked);
      sensitive = [...sensitive, ...await collectCancellationMaterial(authority, this.options.layout.spool_root, purgeId, new Date(createdAt))];
      persistForbiddenContentIdentities(authority, { purge_id: purgeId,
        material: sensitive, observed_at: createdAt });
      let build = await buildFreshAuthority(authority, freshPath,
        { blocked_projections: blocked, sensitive_material: sensitive });
      if ("cancellation" in request) build = sealCancellationSwap(build, purgeId, createdAt);
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
      const swap = await this.swap({ cancellation: "cancellation" in request, fresh_path: freshPath,
        old_device: sourceMetadata.dev, old_inode: sourceMetadata.ino, purge_id: purgeId,
        result_generation: build.result_generation,
        logical_result_digest: build.logical_result_digest,
        physical_scan_digest: build.result_digest, observed_at: createdAt });
      if ("cancellation" in request) {
        const local = this.options.scanner.scanLocal();
        return completeCancellationCompaction(authority, request, this.options.layout, {
          purge_id: purgeId, result_generation: build.result_generation,
          result_device: swap.result_device, result_inode: swap.result_inode,
          reader_drain_digest: swap.reader_drain_digest, physical_scan_digest: build.result_digest,
          local, observed_at: (this.options.clock?.() ?? new Date()).toISOString(),
        }, this.options.clock ?? (() => new Date()));
      }
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
    return this.options.runtime.quiesce("memory_compaction", () =>
      recoverMemoryCompaction(this.options.runtime, this.options.scanner, purgeId));
  }

  private async swap(input: SwapRequest): Promise<SwapObservation> {
    const authority = this.options.runtime.authorityDb();
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
        return this.options.runtime.observeOldInode(input.old_device, input.old_inode);
      } catch (error) {
        authority.reopen();
        throw error;
      }
    })();
    authority.reopen();
    this.options.runtime.acknowledgeGeneration(input.result_generation);
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
    authority.db.prepare("UPDATE memory_compaction_runs SET reader_drain_digest=? WHERE purge_id=?")
      .run(drainDigest, input.purge_id);
    if (input.cancellation) removeRetiredSource(authority.filename, input.purge_id,
      input.old_device.toString(), input.old_inode.toString());
    return { result_device: active.dev.toString(), result_inode: active.ino.toString(),
      old_fd_count: 0, reader_drain_digest: drainDigest };
  }


  private assertRequest(request: MemoryCompactionRequest | CancellationCompactionRequest): void {
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
    ).run(code, (this.options.clock?.() ?? new Date()).toISOString(), purgeId);
    authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='reconciling',lease_owner=NULL,
       lease_expires_at=NULL,updated_at=? WHERE purge_id=? AND state IN ('compacting','verifying')`,
    ).run((this.options.clock?.() ?? new Date()).toISOString(), purgeId);
  }
}

function removeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function syncPath(path: string, directory = false): void {
  const descriptor = openSync(path, directory ? "r" : "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function retiredSourcePath(databasePath: string, purgeId: string): string {
  return join(dirname(databasePath), `.${basename(databasePath)}.${digest(purgeId).slice(7, 31)}.retired`);
}

function removeRetiredSource(databasePath: string, purgeId: string, device: string, inode: string): void {
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
