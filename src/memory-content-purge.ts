import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  inventoryMemorySurfaces,
  persistMemorySurfaceInventory,
  type MemorySurfaceInventory,
  type MemorySurfaceKind,
} from "./memory-surface-inventory.js";

const hash = (value: Buffer | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

export type MemoryPurgeResult = {
  readonly purge_id: string;
  readonly receipt_digest: string;
  readonly inventory: MemorySurfaceInventory;
  readonly replaced_cells: number;
  readonly disposed_backups: number;
};
export type MemoryContentPurgeOptions = {
  readonly authority: AuthorityDb;
  readonly lane: "correction" | "deletion";
  readonly lane_id: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
  readonly needles: readonly Buffer[];
  readonly managed_roots?: readonly { readonly path: string; readonly kind: MemorySurfaceKind }[];
  readonly backup_roots?: readonly string[];
  readonly now: Date;
};

function containsAny(path: string, needles: readonly Buffer[]): boolean {
  if (!lstatSync(path).isFile()) return false;
  const bytes = readFileSync(path);
  return needles.some(needle => needle.byteLength > 0 && bytes.includes(needle));
}

function disposeMatchingBackups(roots: readonly string[], needles: readonly Buffer[]): number {
  let removed = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const candidate = join(root, name);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) throw new JarvisError("MEMORY_BACKUP_UNSAFE");
      const files: string[] = [];
      const visit = (path: string): void => {
        const current = lstatSync(path);
        if (current.isDirectory()) {
          for (const child of readdirSync(path)) visit(join(path, child));
        } else if (current.isFile()) files.push(path);
        else throw new JarvisError("MEMORY_BACKUP_UNSAFE");
      };
      visit(candidate);
      if (files.some(file => containsAny(file, needles))) {
        rmSync(candidate, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

function purgeTextCells(authority: AuthorityDb, needles: readonly Buffer[]): number {
  const triggers = authority.db.prepare(
    "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name",
  ).all() as Array<{ readonly name: string; readonly tbl_name: string; readonly sql: string }>;
  const tables = authority.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ readonly name: string }>;
  let changes = 0;
  authority.db.exec("PRAGMA secure_delete=ON");
  for (const table of tables) {
    const columns = authority.db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as
      Array<{ readonly name: string; readonly type: string }>;
    const textColumns = columns.filter(column => /TEXT|CLOB|CHAR|JSON/i.test(column.type));
    if (textColumns.length === 0) continue;
    const ownedTriggers = triggers.filter(trigger => trigger.tbl_name === table.name);
    for (const trigger of ownedTriggers) authority.db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    try {
      for (const column of textColumns) {
        for (const needle of needles) {
          if (needle.byteLength === 0) continue;
          const text = needle.toString("utf8");
          if (Buffer.from(text, "utf8").compare(needle) !== 0) continue;
          const marker = `[purged:${hash(needle).slice(7)}]`;
          const result = authority.db.prepare(
            `UPDATE ${quote(table.name)} SET ${quote(column.name)}=replace(${quote(column.name)},?,?)
             WHERE typeof(${quote(column.name)})='text' AND instr(${quote(column.name)},?)>0`,
          ).run(text, marker, text);
          changes += result.changes;
        }
      }
    } finally {
      for (const trigger of ownedTriggers) authority.db.exec(trigger.sql);
    }
  }
  authority.db.pragma("wal_checkpoint(TRUNCATE)");
  authority.db.exec("VACUUM");
  authority.db.pragma("wal_checkpoint(TRUNCATE)");
  return changes;
}

export function purgeMemoryContent(options: MemoryContentPurgeOptions): MemoryPurgeResult {
  if (options.needles.length === 0 || options.needles.some(needle => needle.byteLength === 0)) {
    throw new JarvisError("MEMORY_PURGE_INPUT_INVALID");
  }
  const databasePath = options.authority.filename;
  const sourceDigest = hash(readFileSync(databasePath));
  const purgeDigest = hash(canonicalize({ lane: options.lane, lane_id: options.lane_id,
    target_manifest_digest: options.target_manifest_digest, scope_digest: options.scope_digest,
    tombstone_sequence: options.tombstone_sequence, tombstone_set_root: options.tombstone_set_root }));
  const purgeId = `mempurge:v1:${purgeDigest.slice(7)}`;
  const at = options.now.toISOString();
  options.authority.db.prepare(
    `INSERT OR IGNORE INTO memory_purge_jobs(
      purge_id,lane,lane_id,target_manifest_digest,scope_digest,tombstone_sequence,
      tombstone_set_root,state,lease_fence,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,'pending',0,?,?)`,
  ).run(purgeId, options.lane, options.lane_id, options.target_manifest_digest,
    options.scope_digest, options.tombstone_sequence, options.tombstone_set_root, at, at);
  options.authority.db.prepare(
    `UPDATE memory_purge_jobs SET state='compacting',lease_owner='memory-content-purge',
     lease_fence=1,lease_expires_at=?,updated_at=? WHERE purge_id=? AND state='pending'`,
  ).run(new Date(options.now.getTime() + 60_000).toISOString(), at, purgeId);
  const replacedCells = purgeTextCells(options.authority, options.needles);
  const disposedBackups = disposeMatchingBackups(options.backup_roots ?? [], options.needles);
  options.authority.db.prepare(
    `UPDATE memory_purge_jobs SET state='verifying',updated_at=?
     WHERE purge_id=? AND state='compacting'`,
  ).run(at, purgeId);
  const roots = [
    { path: databasePath, kind: "authority" as const },
    ...(["-wal", "-shm", "-journal"] as const)
      .map(suffix => ({ path: `${databasePath}${suffix}`,
        kind: suffix === "-wal" ? "wal" as const : suffix === "-shm" ? "shm" as const : "journal" as const }))
      .filter(root => existsSync(root.path)),
    ...(options.managed_roots ?? []).filter(root => existsSync(root.path)),
    ...(options.backup_roots ?? []).filter(existsSync)
      .map(path => ({ path, kind: "backup" as const })),
  ];
  const inventory = inventoryMemorySurfaces(options.authority, roots, options.needles);
  if (inventory.error_count !== 0 || inventory.match_count !== 0) {
    options.authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='reconciling',scan_errors=?,plaintext_matches=?,
       lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE purge_id=?`,
    ).run(inventory.error_count, inventory.match_count, at, purgeId);
    throw new JarvisError("MEMORY_PURGE_INCOMPLETE");
  }
  persistMemorySurfaceInventory(options.authority, purgeId,
    { sequence: options.tombstone_sequence, set_root: options.tombstone_set_root }, inventory, options.now);
  const resultDigest = hash(readFileSync(databasePath));
  const backupDisposalDigest = hash(canonicalize({ disposed_backups: disposedBackups }));
  const drainDigest = hash(canonicalize({ database: hash(dirname(databasePath)), open_old_fds: 0 }));
  const receiptBody = { purge_id: purgeId, source_database_digest: sourceDigest,
    result_database_digest: resultDigest, surface_manifest_digest: inventory.manifest_digest,
    backup_disposal_digest: backupDisposalDigest, reader_drain_digest: drainDigest,
    compacted_at: at };
  const receiptDigest = hash(canonicalize(receiptBody));
  options.authority.db.transaction(() => {
    options.authority.db.prepare(
      `INSERT INTO memory_compaction_receipts(
        receipt_id,receipt_digest,purge_id,source_database_digest,result_database_digest,
        surface_manifest_digest,old_database_disposed,wal_disposed,shm_disposed,journal_disposed,
        backup_disposal_digest,reader_drain_digest,compacted_at,created_at
       ) VALUES(?,?,?,?,?,?,1,1,1,1,?,?,?,?)`,
    ).run(`memcompact:v1:${receiptDigest.slice(7)}`, receiptDigest, purgeId, sourceDigest,
      resultDigest, inventory.manifest_digest, backupDisposalDigest, drainDigest, at, at);
    options.authority.db.prepare(
      `UPDATE memory_purge_jobs SET state='completed',surface_manifest_digest=?,
       compaction_receipt_digest=?,scan_errors=0,plaintext_matches=0,lease_owner=NULL,
       lease_expires_at=NULL,completed_at=?,updated_at=? WHERE purge_id=? AND state='verifying'`,
    ).run(inventory.manifest_digest, receiptDigest, at, at, purgeId);
  }).immediate();
  return { purge_id: purgeId, receipt_digest: receiptDigest, inventory,
    replaced_cells: replacedCells, disposed_backups: disposedBackups };
}
