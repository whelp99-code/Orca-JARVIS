import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const hashBytes = (value: Buffer | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export type MemorySurfaceKind = "authority" | "projection" | "state" | "backup" | "spool" | "wal" | "shm" | "journal" | "fd" | "restore";
export type MemorySurfaceEntry = {
  readonly surface_id: string;
  readonly surface_kind: MemorySurfaceKind;
  readonly manifest_digest: string;
  readonly readable: boolean;
  readonly file_count: number;
  readonly row_count: number;
  readonly object_count: number;
  readonly fd_count: number;
  readonly match_count: number;
  readonly error_count: number;
  readonly scan_digest: string;
};
export type MemorySurfaceInventory = {
  readonly manifest_id: string;
  readonly manifest_digest: string;
  readonly entries: readonly MemorySurfaceEntry[];
  readonly file_count: number;
  readonly row_count: number;
  readonly object_count: number;
  readonly fd_count: number;
  readonly match_count: number;
  readonly error_count: number;
};

function countNeedles(bytes: Buffer, needles: readonly Buffer[]): number {
  return needles.reduce((total, needle) => {
    if (needle.byteLength === 0) return total;
    let offset = 0;
    let count = 0;
    while ((offset = bytes.indexOf(needle, offset)) >= 0) {
      count += 1;
      offset += needle.byteLength;
    }
    return total + count;
  }, 0);
}

function scanRoot(
  root: string,
  kind: MemorySurfaceKind,
  needles: readonly Buffer[],
): MemorySurfaceEntry {
  const rows: Array<{ readonly id: string; readonly digest: string; readonly bytes: number; readonly matches: number }> = [];
  let errors = 0;
  const visit = (path: string): void => {
    let metadata;
    try { metadata = lstatSync(path); } catch { errors += 1; return; }
    if (metadata.isSymbolicLink()) { errors += 1; return; }
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) { errors += 1; return; }
    try {
      const bytes = readFileSync(path);
      rows.push({ id: hashBytes(relative(root, path)), digest: hashBytes(bytes),
        bytes: bytes.byteLength, matches: countNeedles(bytes, needles) });
    } catch { errors += 1; }
  };
  visit(root);
  const matches = rows.reduce((total, row) => total + row.matches, 0);
  const body = { surface_kind: kind, files: rows, errors };
  const scanDigest = hashBytes(canonicalize(body));
  return Object.freeze({
    surface_id: hashBytes(`${kind}\0${root}`),
    surface_kind: kind,
    manifest_digest: hashBytes(canonicalize(rows.map(row => ({ id: row.id, digest: row.digest })))),
    readable: errors === 0,
    file_count: rows.length,
    row_count: 0,
    object_count: 0,
    fd_count: 0,
    match_count: matches,
    error_count: errors,
    scan_digest: scanDigest,
  });
}

export function inventoryMemorySurfaces(
  authority: AuthorityDb,
  roots: readonly { readonly path: string; readonly kind: MemorySurfaceKind }[],
  needles: readonly Buffer[],
): MemorySurfaceInventory {
  const entries = roots.map(root => scanRoot(root.path, root.kind, needles));
  const tables = authority.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ readonly name: string }>;
  const rowCount = tables.reduce((total, table) => total + Number((authority.db.prepare(
    `SELECT COUNT(*) AS count FROM "${table.name}"`,
  ).get() as { readonly count: number }).count), 0);
  const fileCount = entries.reduce((total, entry) => total + entry.file_count, 0);
  const objectCount = entries.reduce((total, entry) => total + entry.object_count, 0);
  const fdCount = entries.reduce((total, entry) => total + entry.fd_count, 0);
  const matchCount = entries.reduce((total, entry) => total + entry.match_count, 0);
  const errorCount = entries.reduce((total, entry) => total + entry.error_count, 0);
  const body = { entries, file_count: fileCount, row_count: rowCount,
    object_count: objectCount, fd_count: fdCount, match_count: matchCount,
    error_count: errorCount };
  const manifestDigest = hashBytes(canonicalize(body));
  return Object.freeze({ manifest_id: `memsurface:v1:${manifestDigest.slice(7)}`,
    manifest_digest: manifestDigest, entries, file_count: fileCount, row_count: rowCount,
    object_count: objectCount, fd_count: fdCount, match_count: matchCount,
    error_count: errorCount });
}

export function persistMemorySurfaceInventory(
  authority: AuthorityDb,
  purgeId: string,
  tombstone: { readonly sequence: number; readonly set_root: string },
  inventory: MemorySurfaceInventory,
  now: Date,
): void {
  if (inventory.entries.length === 0 || inventory.match_count !== 0 || inventory.error_count !== 0) {
    throw new JarvisError("MEMORY_SURFACE_INVENTORY_INVALID");
  }
  const at = now.toISOString();
  authority.db.transaction(() => {
    authority.db.prepare(
      `INSERT INTO memory_surface_manifests(
        manifest_id,manifest_digest,purge_id,owner,tombstone_sequence,tombstone_set_root,
        surface_count,file_count,row_count,object_count,fd_count,match_count,error_count,created_at
       ) VALUES(?,?,?,'jarvis',?,?,?,?,?,?,?,0,0,?)`,
    ).run(inventory.manifest_id, inventory.manifest_digest, purgeId, tombstone.sequence,
      tombstone.set_root, inventory.entries.length, inventory.file_count, inventory.row_count,
      inventory.object_count, inventory.fd_count, at);
    const insert = authority.db.prepare(
      `INSERT INTO memory_surface_entries(
        manifest_id,surface_id,surface_kind,manifest_digest,readable,file_count,row_count,
        object_count,fd_count,match_count,error_count,scan_digest
       ) VALUES(?,?,?,?,?,?,?,?,?,0,0,?)`,
    );
    for (const entry of inventory.entries) insert.run(inventory.manifest_id, entry.surface_id,
      entry.surface_kind, entry.manifest_digest, entry.readable ? 1 : 0, entry.file_count,
      entry.row_count, entry.object_count, entry.fd_count, entry.scan_digest);
  }).immediate();
}
