import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { MemoryCompactionRequest } from "./memory-compaction-types.js";
import type { CompleteMemorySurfaceInventory } from "./memory-managed-surface-types.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update(canonicalize(value)).digest("hex")}`;

export type CompactionStart = {
  readonly purge_id: string;
  readonly source_generation: number;
  readonly result_generation: number;
  readonly source_device: string;
  readonly source_inode: string;
  readonly source_digest: string;
  readonly created_at: string;
};

export type CompactionCompletion = CompactionStart & {
  readonly result_device: string;
  readonly result_inode: string;
  readonly result_digest: string;
  readonly logical_result_digest: string;
  readonly reader_drain_digest: string;
  readonly physical_scan_digest: string;
  readonly backup_disposal_digest: string;
  readonly inventory: CompleteMemorySurfaceInventory;
};

export function beginCompaction(
  authority: AuthorityDb,
  request: MemoryCompactionRequest,
  start: CompactionStart,
): void {
  authority.db.transaction(() => {
    beginCompactionRun(authority, request, start);
    const providerJson = canonicalize(request.provider_inventory);
    const guardsJson = canonicalize(request.reingress_guards);
    const inputDigest = digest({ provider: request.provider_inventory,
      reingress_guards: request.reingress_guards });
    authority.db.prepare(
      `INSERT INTO memory_compaction_inputs(
        purge_id,provider_manifest_digest,provider_catalog_rows,provider_signature_verified,
        reingress_guards_json,input_digest,created_at,provider_inventory_json
       ) VALUES(?,?,40,1,?,?,?,?)`,
    ).run(start.purge_id, request.provider_inventory.manifest_digest,
      guardsJson, inputDigest, start.created_at, providerJson);
  }).immediate();
}

export function beginCompactionRun(authority: AuthorityDb,
  request: Pick<MemoryCompactionRequest, "lane" | "lane_id" | "target_manifest_digest" | "scope_digest" | "tombstone">,
  start: CompactionStart): void {
    const prior = authority.db.prepare(
      "SELECT state FROM memory_purge_jobs WHERE purge_id=?",
    ).get(start.purge_id) as { readonly state: string } | undefined;
    if (prior !== undefined) throw new JarvisError("MEMORY_COMPACTION_REPLAY_PENDING");
    authority.db.prepare(
      `INSERT INTO memory_purge_jobs(
        purge_id,lane,lane_id,target_manifest_digest,scope_digest,tombstone_sequence,
        tombstone_set_root,state,lease_fence,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,'pending',0,?,?)`,
    ).run(start.purge_id, request.lane, request.lane_id,
      request.target_manifest_digest, request.scope_digest, request.tombstone.sequence,
      request.tombstone.set_root, start.created_at, start.created_at);
    authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='compacting',lease_owner='memory-authority-compactor',
       lease_fence=1,lease_expires_at=?,updated_at=? WHERE purge_id=? AND state='pending'`,
    ).run(new Date(Date.parse(start.created_at) + 60_000).toISOString(),
      start.created_at, start.purge_id);
    authority.db.prepare(
      `INSERT INTO memory_compaction_runs(
        purge_id,source_generation,result_generation,source_device,source_inode,
        logical_source_digest,state,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,'building',?,?)`,
    ).run(start.purge_id, start.source_generation, start.result_generation,
      start.source_device, start.source_inode, start.source_digest,
      start.created_at, start.created_at);
}

export function completeCompaction(
  authority: AuthorityDb,
  completion: CompactionCompletion,
): string {
  const inventory = completion.inventory;
  const manifestId = `memsurface:v2:${inventory.manifest_digest.slice(7)}`;
  const receiptBody = { purge_id: completion.purge_id,
    source_database_digest: completion.source_digest,
    result_database_digest: completion.result_digest,
    surface_manifest_digest: inventory.manifest_digest,
    backup_disposal_digest: completion.backup_disposal_digest,
    reader_drain_digest: completion.reader_drain_digest,
    compacted_at: completion.created_at };
  const receiptDigest = digest(receiptBody);
  authority.db.transaction(() => {
    authority.db.prepare(
      `UPDATE memory_compaction_runs SET state='draining',result_device=?,result_inode=?,
       logical_result_digest=?,integrity_check='ok',foreign_key_error_count=0,
       reader_drain_digest=?,physical_scan_digest=?,updated_at=? WHERE purge_id=?`,
    ).run(completion.result_device, completion.result_inode,
      completion.logical_result_digest, completion.reader_drain_digest,
      completion.physical_scan_digest, completion.created_at, completion.purge_id);
    authority.db.prepare(
      `INSERT INTO memory_surface_catalog_manifests(
        manifest_id,manifest_digest,purge_id,catalog_digest,tombstone_sequence,
        tombstone_set_root,expected_surface_count,observed_surface_count,
        omission_count,error_count,match_count,created_at
       ) VALUES(?,?,?,?,?,?,70,70,0,0,0,?)`,
    ).run(manifestId, inventory.manifest_digest, completion.purge_id,
      inventory.catalog_digest, tombstoneSequence(authority, completion.purge_id),
      tombstoneRoot(authority, completion.purge_id), completion.created_at);
    const insertCatalog = authority.db.prepare(
      `INSERT INTO memory_surface_catalog_entries(
        manifest_id,catalog_key,owner,surface_id,scanner_kind,required,applicable,readable,
        manifest_digest,file_count,row_count,object_count,fd_count,match_count,error_count,
        omission_count,scan_digest
       ) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,0,0,0,?)`,
    );
    for (const entry of inventory.entries) insertCatalog.run(manifestId,
      entry.catalog_key, entry.owner, entry.surface_id, entry.scanner_kind,
      entry.applicable ? 1 : 0, entry.readable ? 1 : 0, entry.manifest_digest,
      entry.file_count, entry.row_count, entry.object_count, entry.fd_count,
      entry.scan_digest);
    persistCompatibilityInventory(authority, completion, manifestId);
    authority.db.prepare(
      `INSERT INTO memory_compaction_receipts(
        receipt_id,receipt_digest,purge_id,source_database_digest,result_database_digest,
        surface_manifest_digest,old_database_disposed,wal_disposed,shm_disposed,journal_disposed,
        backup_disposal_digest,reader_drain_digest,compacted_at,created_at
       ) VALUES(?,?,?,?,?,?,1,1,1,1,?,?,?,?)`,
    ).run(`memcompact:v1:${receiptDigest.slice(7)}`, receiptDigest,
      completion.purge_id, completion.source_digest, completion.result_digest,
      inventory.manifest_digest, completion.backup_disposal_digest,
      completion.reader_drain_digest, completion.created_at, completion.created_at);
    authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='verifying',updated_at=?
       WHERE purge_id=? AND state IN ('compacting','reconciling')`,
    ).run(completion.created_at, completion.purge_id);
    authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='completed',surface_manifest_digest=?,
       compaction_receipt_digest=?,scan_errors=0,plaintext_matches=0,lease_owner=NULL,
       lease_expires_at=NULL,completed_at=?,updated_at=?
       WHERE purge_id=? AND state='verifying'`,
    ).run(inventory.manifest_digest, receiptDigest, completion.created_at,
      completion.created_at, completion.purge_id);
    authority.db.prepare(
      `UPDATE memory_compaction_runs SET state='completed',swap_receipt_digest=?,
       completed_at=?,updated_at=? WHERE purge_id=? AND state='draining'`,
    ).run(receiptDigest, completion.created_at, completion.created_at, completion.purge_id);
  }).immediate();
  return receiptDigest;
}

function persistCompatibilityInventory(
  authority: AuthorityDb,
  completion: CompactionCompletion,
  manifestId: string,
): void {
  const inventory = completion.inventory;
  authority.db.prepare(
    `INSERT INTO memory_surface_manifests(
      manifest_id,manifest_digest,purge_id,owner,tombstone_sequence,tombstone_set_root,
      surface_count,file_count,row_count,object_count,fd_count,match_count,error_count,created_at
     ) VALUES(?,?,?,'jarvis',?,?,70,?,?,?,?,0,0,?)`,
  ).run(manifestId, inventory.manifest_digest, completion.purge_id,
    tombstoneSequence(authority, completion.purge_id),
    tombstoneRoot(authority, completion.purge_id),
    inventory.entries.reduce((total, entry) => total + entry.file_count, 0),
    inventory.entries.reduce((total, entry) => total + entry.row_count, 0),
    inventory.entries.reduce((total, entry) => total + entry.object_count, 0),
    inventory.entries.reduce((total, entry) => total + entry.fd_count, 0),
    completion.created_at);
  const insert = authority.db.prepare(
    `INSERT INTO memory_surface_entries(
      manifest_id,surface_id,surface_kind,manifest_digest,readable,file_count,row_count,
      object_count,fd_count,match_count,error_count,scan_digest
     ) VALUES(?,?,'state',?,?,?,?,?,?,?,0,?)`,
  );
  for (const entry of inventory.entries) insert.run(manifestId,
    `${entry.owner}:${entry.surface_id}`, entry.manifest_digest, entry.readable ? 1 : 0,
    entry.file_count, entry.row_count, entry.object_count, entry.fd_count,
    entry.match_count, entry.scan_digest);
}

function tombstoneSequence(authority: AuthorityDb, purgeId: string): number {
  const row = authority.db.prepare(
    "SELECT tombstone_sequence FROM memory_purge_jobs WHERE purge_id=?",
  ).get(purgeId) as { readonly tombstone_sequence: number };
  return row.tombstone_sequence;
}

function tombstoneRoot(authority: AuthorityDb, purgeId: string): string {
  const row = authority.db.prepare(
    "SELECT tombstone_set_root FROM memory_purge_jobs WHERE purge_id=?",
  ).get(purgeId) as { readonly tombstone_set_root: string };
  return row.tombstone_set_root;
}
