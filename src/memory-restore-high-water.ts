import { copyFile, chmod, mkdir, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { purgeMemoryContent } from "./memory-content-purge.js";
import { MemoryTombstoneChain } from "./memory-tombstone-chain.js";

const hash = (value: Buffer | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export type MemoryRestoreResult = {
  readonly restore_id: string;
  readonly disposition: "sanitized" | "rejected_stale" | "rejected_conflict";
  readonly sanitized_path: string | null;
  readonly activated: false;
  readonly receipt_digest: string;
};

export async function sanitizeMemoryRestoreCandidate(input: {
  readonly authority: AuthorityDb;
  readonly source: string;
  readonly workspace: string;
  readonly subject_key: Buffer;
  readonly needles: readonly Buffer[];
  readonly now: Date;
}): Promise<MemoryRestoreResult> {
  const workspace = resolve(input.workspace);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await chmod(workspace, 0o700);
  const sourceFile = await open(resolve(input.source), constants.O_RDONLY | constants.O_NOFOLLOW);
  let sourceDigest: string;
  try {
    const metadata = await sourceFile.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new JarvisError("MEMORY_RESTORE_SOURCE_UNSAFE");
    sourceDigest = hash(await sourceFile.readFile());
  } finally { await sourceFile.close(); }
  const current = new MemoryTombstoneChain(input.authority, input.subject_key).highWater();
  const sourceDb = new AuthorityDb(input.source);
  let source = { sequence: 0, set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3" };
  try {
    const hasChain = sourceDb.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_tombstone_chain'",
    ).get() !== undefined;
    if (hasChain) source = (sourceDb.db.prepare(
      "SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1",
    ).get() as typeof source | undefined) ?? source;
  } finally { sourceDb.close(); }
  const restoreDigest = hash(canonicalize({ source_database_digest: sourceDigest,
    source_sequence: source.sequence, source_set_root: source.set_root,
    current_sequence: current.sequence, current_set_root: current.set_root }));
  const restoreId = `memrestore:v1:${restoreDigest.slice(7)}`;
  if (source.sequence > current.sequence || (source.sequence === current.sequence
    && source.set_root !== current.set_root)) {
    const disposition = source.sequence > current.sequence ? "rejected_stale" : "rejected_conflict";
    const receiptDigest = recordRestore(input.authority, { restore_id: restoreId,
      source_database_digest: sourceDigest, source_sequence: source.sequence,
      source_set_root: source.set_root, current_sequence: current.sequence,
      current_set_root: current.set_root, disposition, sanitized_database_digest: null,
      surface_manifest_digest: null }, input.now);
    return { restore_id: restoreId, disposition, sanitized_path: null,
      activated: false, receipt_digest: receiptDigest };
  }
  const candidate = join(workspace, `restore-${randomUUID()}.sqlite`);
  await copyFile(input.source, candidate, constants.COPYFILE_EXCL);
  await chmod(candidate, 0o600);
  const restored = new AuthorityDb(candidate);
  let purge;
  try {
    await restored.migrate();
    replicateTombstoneState(input.authority, restored);
    purge = purgeMemoryContent({ authority: restored, lane: "deletion", lane_id: restoreId,
      target_manifest_digest: hash("restore-target"), scope_digest: hash("restore-scope"),
      tombstone_sequence: current.sequence, tombstone_set_root: current.set_root,
      needles: input.needles, managed_roots: [], backup_roots: [], now: input.now });
  } catch (error) {
    restored.close(); await rm(candidate, { force: true }); throw error;
  }
  restored.close();
  const sanitizedFile = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sanitizedDigest: string;
  try { sanitizedDigest = hash(await sanitizedFile.readFile()); }
  finally { await sanitizedFile.close(); }
  const receiptDigest = recordRestore(input.authority, { restore_id: restoreId,
    source_database_digest: sourceDigest, source_sequence: source.sequence,
    source_set_root: source.set_root, current_sequence: current.sequence,
    current_set_root: current.set_root, disposition: "sanitized",
    sanitized_database_digest: sanitizedDigest,
    surface_manifest_digest: purge.inventory.manifest_digest }, input.now);
  return { restore_id: restoreId, disposition: "sanitized", sanitized_path: candidate,
    activated: false, receipt_digest: receiptDigest };
}

function replicateTombstoneState(source: AuthorityDb, destination: AuthorityDb): void {
  const chains = source.db.prepare(
    "SELECT * FROM memory_tombstone_chain ORDER BY sequence",
  ).all() as Array<Record<string, string | number>>;
  const insertChain = destination.db.prepare(
    `INSERT OR IGNORE INTO memory_tombstone_chain(
      sequence,tombstone_id,operation,lane_id,target_manifest_digest,scope_digest,
      authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,
      previous_root,set_root,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of chains) insertChain.run(row.sequence, row.tombstone_id, row.operation,
    row.lane_id, row.target_manifest_digest, row.scope_digest, row.authority_receipt_digest,
    row.payload_digest, row.keyed_subject_digest, row.effective_at, row.previous_root,
    row.set_root, row.created_at);
  const suppressions = source.db.prepare(
    "SELECT * FROM memory_suppressions ORDER BY sequence,suppression_id",
  ).all() as Array<Record<string, string | number>>;
  const insertSuppression = destination.db.prepare(
    `INSERT OR IGNORE INTO memory_suppressions(
      suppression_id,sequence,operation,target_digest,target_manifest_digest,scope_digest,
      keyed_subject_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
      state,effective_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of suppressions) insertSuppression.run(row.suppression_id, row.sequence,
    row.operation, row.target_digest, row.target_manifest_digest, row.scope_digest,
    row.keyed_subject_digest, row.source_identity_digest, row.content_identity_digest,
    row.citation_identity_digest, row.state, row.effective_at, row.created_at);
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
