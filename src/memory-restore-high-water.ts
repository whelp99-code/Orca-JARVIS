import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { buildFreshAuthority } from "./memory-authority-fresh-builder.js";
import {
  applyCurrentRestoreAuthority,
  restoreBlockedProjections,
} from "./memory-restore-authority.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "./second-brain-effect-v2.js";

const hash = (value: Buffer | string): string => `sha256:${createHash("sha256")
  .update(value).digest("hex")}`;

export type MemoryRestoreResult = {
  readonly restore_id: string;
  readonly disposition: "sanitized" | "rejected_stale" | "rejected_conflict";
  readonly sanitized_path: string | null;
  readonly activated: false;
  readonly receipt_digest: string;
};

type RestoreInput = {
  readonly authority: AuthorityDb;
  readonly source: string;
  readonly workspace: string;
  readonly now: Date;
};

type HighWater = { readonly sequence: number; readonly set_root: string };

export async function sanitizeMemoryRestoreCandidate(input: RestoreInput): Promise<MemoryRestoreResult> {
  const workspace = resolve(input.workspace);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await chmod(workspace, 0o700);
  const sourcePath = resolve(input.source);
  const sourceDigest = await secureSourceDigest(sourcePath);
  const current = highWater(input.authority);
  const sourceDb = new AuthorityDb(sourcePath);
  const source = highWater(sourceDb);
  const restoreDigest = hash(canonicalize({ source_database_digest: sourceDigest,
    source_sequence: source.sequence, source_set_root: source.set_root,
    current_sequence: current.sequence, current_set_root: current.set_root }));
  const restoreId = `memrestore:v2:${restoreDigest.slice(7)}`;
  const rejection = rejectedDisposition(input.authority, source, current);
  if (rejection !== undefined) {
    sourceDb.close();
    const receiptDigest = recordRestore(input.authority, { restore_id: restoreId,
      source_database_digest: sourceDigest, source_sequence: source.sequence,
      source_set_root: source.set_root, current_sequence: current.sequence,
      current_set_root: current.set_root, disposition: rejection,
      sanitized_database_digest: null, surface_manifest_digest: null }, input.now);
    return { restore_id: restoreId, disposition: rejection,
      sanitized_path: null, activated: false, receipt_digest: receiptDigest };
  }
  const candidate = join(workspace, `restore-${randomUUID()}.sqlite`);
  let sensitive: Buffer[] = [];
  try {
    const blocked = restoreBlockedProjections(sourceDb, input.authority);
    const build = await buildFreshAuthority(sourceDb, candidate, blocked);
    sensitive = build.sensitive_material;
    sourceDb.close();
    const restored = new AuthorityDb(candidate);
    try {
      applyCurrentRestoreAuthority(input.authority, restored);
      restored.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      restored.close();
    }
    await removeSidecars(candidate);
    const sanitized = await secureSourceDigest(candidate);
    const bytes = await readSecureFile(candidate);
    if (sensitive.some(value => value.byteLength > 0 && bytes.includes(value))) {
      throw new JarvisError("MEMORY_RESTORE_SANITATION_FAILED");
    }
    const inventoryDigest = hash(canonicalize({ blocked, sanitized,
      current_sequence: current.sequence, current_set_root: current.set_root }));
    const receiptDigest = recordRestore(input.authority, { restore_id: restoreId,
      source_database_digest: sourceDigest, source_sequence: source.sequence,
      source_set_root: source.set_root, current_sequence: current.sequence,
      current_set_root: current.set_root, disposition: "sanitized",
      sanitized_database_digest: sanitized,
      surface_manifest_digest: inventoryDigest }, input.now);
    return { restore_id: restoreId, disposition: "sanitized",
      sanitized_path: candidate, activated: false, receipt_digest: receiptDigest };
  } catch (error) {
    if (sourceDb.db.open) sourceDb.close();
    await rm(candidate, { force: true });
    await removeSidecars(candidate);
    throw error;
  } finally {
    for (const value of sensitive) value.fill(0);
  }
}

function highWater(authority: AuthorityDb): HighWater {
  const table = authority.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_tombstone_chain'",
  ).get();
  if (table === undefined) return { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
  const row = authority.db.prepare(
    "SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1",
  ).get();
  if (row === undefined) return { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
  if (row === null || typeof row !== "object"
    || typeof Reflect.get(row, "sequence") !== "number"
    || typeof Reflect.get(row, "set_root") !== "string") {
    throw new JarvisError("MEMORY_RESTORE_HIGH_WATER_INVALID");
  }
  return { sequence: Number(Reflect.get(row, "sequence")),
    set_root: String(Reflect.get(row, "set_root")) };
}

function rejectedDisposition(
  authority: AuthorityDb,
  source: HighWater,
  current: HighWater,
): "rejected_stale" | "rejected_conflict" | undefined {
  if (source.sequence > current.sequence) return "rejected_stale";
  if (source.sequence === 0) {
    return source.set_root === MEMORY_TOMBSTONE_GENESIS_ROOT ? undefined : "rejected_conflict";
  }
  const prefix = authority.db.prepare(
    "SELECT set_root FROM memory_tombstone_chain WHERE sequence=?",
  ).get(source.sequence);
  const root = prefix !== null && typeof prefix === "object" ? Reflect.get(prefix, "set_root") : undefined;
  return root === source.set_root ? undefined : "rejected_conflict";
}

async function secureSourceDigest(path: string): Promise<string> {
  return hash(await readSecureFile(path));
}

async function readSecureFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new JarvisError("MEMORY_RESTORE_SOURCE_UNSAFE");
    return await file.readFile();
  } finally { await file.close(); }
}

async function removeSidecars(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
}

function recordRestore(authority: AuthorityDb, value: {
  readonly restore_id: string; readonly source_database_digest: string;
  readonly source_sequence: number; readonly source_set_root: string;
  readonly current_sequence: number; readonly current_set_root: string;
  readonly disposition: "sanitized" | "rejected_stale" | "rejected_conflict";
  readonly sanitized_database_digest: string | null; readonly surface_manifest_digest: string | null;
}, now: Date): string {
  const receiptDigest = hash(canonicalize({ ...value, activated: 0, created_at: now.toISOString() }));
  authority.db.prepare(
    `INSERT INTO memory_restore_high_water_receipts(
      receipt_id,restore_id,source_database_digest,source_sequence,source_set_root,current_sequence,
      current_set_root,disposition,sanitized_database_digest,surface_manifest_digest,activated,
      created_at,receipt_digest
     ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)`,
  ).run(`memrestore-receipt:v1:${receiptDigest.slice(7)}`, value.restore_id,
    value.source_database_digest, value.source_sequence, value.source_set_root,
    value.current_sequence, value.current_set_root, value.disposition,
    value.sanitized_database_digest, value.surface_manifest_digest, now.toISOString(), receiptDigest);
  return receiptDigest;
}
