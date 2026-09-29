import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { recomputeStoredHead } from "./provider-tombstone-replica-learn.js";
import { canonicalize } from "./canonical.js";
import {
  MEMORY_TOMBSTONE_GENESIS_ROOT, memoryEffectDigest, type MemoryTombstoneChainEntryV2,
} from "./second-brain-effect-v2.js";

export const PROVIDER_TOMBSTONE_REPLICA_DOMAIN = "second-brain/provider-tombstone-replica/v1\0";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOMBSTONE_ID = /^memtomb:v1:[0-9a-f]{64}$/;

export type ProviderTombstoneTarget = {
  readonly sequence: number;
  readonly target_digest: string;
  readonly source_identity_digest: string;
  readonly content_identity_digest: string;
  readonly citation_identity_digest: string;
  readonly subject_identity_digest: string;
  readonly page_content_digest: string;
};
export type ProviderTombstoneReplica = {
  readonly schema_version: 1;
  readonly kind: "provider_tombstone_replica";
  readonly provider_instance_id: string;
  readonly signing_key_id: string;
  readonly issued_at: string;
  readonly sequence: number;
  readonly set_root: string;
  readonly entries: readonly MemoryTombstoneChainEntryV2[];
  readonly targets: readonly ProviderTombstoneTarget[];
  readonly signature: string;
};
export type ProviderTombstoneHighWater = { readonly sequence: number; readonly set_root: string };

type UnsignedReplica = Omit<ProviderTombstoneReplica, "signature">;

function fail(code: string): never { throw new JarvisError(code); }
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined;
}
function digest(value: string, code: string): string {
  if (!DIGEST.test(value)) fail(code);
  return value;
}
function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) fail(code);
  return value;
}

export function providerTombstoneLinkRoot(entry: Pick<MemoryTombstoneChainEntryV2,
  "sequence" | "operation" | "lane_id" | "target_manifest_digest" | "scope_digest"
  | "authority_receipt_digest" | "payload_digest" | "keyed_subject_digest" | "effective_at" | "previous_root">): string {
  return memoryEffectDigest("tombstone_chain", {
    sequence: entry.sequence, operation: entry.operation, lane_id: entry.lane_id,
    target_manifest_digest: entry.target_manifest_digest, scope_digest: entry.scope_digest,
    authority_receipt_digest: entry.authority_receipt_digest, payload_digest: entry.payload_digest,
    keyed_subject_digest: entry.keyed_subject_digest, effective_at: entry.effective_at,
    previous_root: entry.previous_root,
  });
}

function entryFrom(value: unknown): MemoryTombstoneChainEntryV2 {
  const row = record(value) ?? fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  const operation = row.operation;
  if (operation !== "correct" && operation !== "forget") fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1) fail("PROVIDER_TOMBSTONE_REPLICA_GAP");
  const entry: MemoryTombstoneChainEntryV2 = {
    sequence: Number(row.sequence),
    tombstone_id: text(row.tombstone_id, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    operation, lane_id: text(row.lane_id, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    target_manifest_digest: digest(text(row.target_manifest_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    scope_digest: digest(text(row.scope_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    authority_receipt_digest: digest(text(row.authority_receipt_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    payload_digest: digest(text(row.payload_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    keyed_subject_digest: text(row.keyed_subject_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    effective_at: text(row.effective_at, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    previous_root: digest(text(row.previous_root, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    set_root: digest(text(row.set_root, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
  };
  if (!TOMBSTONE_ID.test(entry.tombstone_id) || !INSTANT.test(entry.effective_at)
    || entry.keyed_subject_digest.length < 16 || entry.keyed_subject_digest.length > 200) {
    fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  }
  return entry;
}

function targetFrom(value: unknown): ProviderTombstoneTarget {
  const row = record(value) ?? fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1) fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  return {
    sequence: Number(row.sequence),
    target_digest: digest(text(row.target_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    source_identity_digest: text(row.source_identity_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    content_identity_digest: text(row.content_identity_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    citation_identity_digest: text(row.citation_identity_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    subject_identity_digest: text(row.subject_identity_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    page_content_digest: digest(text(row.page_content_digest, "PROVIDER_TOMBSTONE_REPLICA_INVALID"), "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
  };
}

/** Recompute the chain from genesis. A bad link is tamper; a skipped sequence is a gap;
 * a declared tip that is not the recomputed tip is stale. */
export function verifyProviderTombstoneChain(entries: readonly MemoryTombstoneChainEntryV2[],
  declared: ProviderTombstoneHighWater): ProviderTombstoneHighWater {
  let previous = MEMORY_TOMBSTONE_GENESIS_ROOT;
  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1) fail("PROVIDER_TOMBSTONE_REPLICA_GAP");
    const observed = providerTombstoneLinkRoot(entry);
    if (entry.previous_root !== previous || entry.set_root !== observed
      || entry.tombstone_id !== `memtomb:v1:${observed.slice(7)}`) {
      fail("PROVIDER_TOMBSTONE_REPLICA_TAMPERED");
    }
    previous = observed;
  });
  if (declared.sequence !== entries.length || declared.set_root !== previous) {
    fail("PROVIDER_TOMBSTONE_REPLICA_STALE");
  }
  return { sequence: entries.length, set_root: previous };
}

function unsigned(replica: ProviderTombstoneReplica): UnsignedReplica {
  return {
    schema_version: 1, kind: "provider_tombstone_replica",
    provider_instance_id: replica.provider_instance_id, signing_key_id: replica.signing_key_id,
    issued_at: replica.issued_at, sequence: replica.sequence, set_root: replica.set_root,
    entries: replica.entries, targets: replica.targets,
  };
}

export function verifyProviderTombstoneReplica(value: unknown,
  keys: ReadonlyMap<string, KeyObject | string>): ProviderTombstoneReplica {
  const row = record(value) ?? fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (row.schema_version !== 1 || row.kind !== "provider_tombstone_replica") fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (!Array.isArray(row.entries) || !Array.isArray(row.targets) || row.entries.length > 256 || row.targets.length > 4096) {
    fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  }
  const issued = text(row.issued_at, "PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (!INSTANT.test(issued)) fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  const replica: ProviderTombstoneReplica = {
    schema_version: 1, kind: "provider_tombstone_replica",
    provider_instance_id: text(row.provider_instance_id, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    signing_key_id: text(row.signing_key_id, "PROVIDER_TOMBSTONE_REPLICA_INVALID"),
    issued_at: issued,
    sequence: Number(row.sequence), set_root: digest(text(row.set_root, "PROVIDER_TOMBSTONE_REPLICA_STALE"), "PROVIDER_TOMBSTONE_REPLICA_STALE"),
    entries: row.entries.map(entryFrom), targets: row.targets.map(targetFrom),
    signature: text(row.signature, "PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID"),
  };
  if (!Number.isSafeInteger(replica.sequence) || replica.sequence < 0) fail("PROVIDER_TOMBSTONE_REPLICA_STALE");
  const key = keys.get(replica.signing_key_id);
  if (key === undefined) fail("PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID");
  const body = unsigned(replica);
  let signature: Buffer;
  try { signature = Buffer.from(replica.signature, "base64url"); }
  catch { fail("PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID"); }
  if (signature.byteLength !== 64) fail("PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID");
  const material = typeof key === "string" ? createPublicKey(key) : key;
  const valid = verify(null, Buffer.from(PROVIDER_TOMBSTONE_REPLICA_DOMAIN + canonicalize(body)), material, signature);
  if (!valid) fail("PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID");
  verifyProviderTombstoneChain(replica.entries, replica);
  const covered = new Set(replica.targets.map(target => target.sequence));
  if (replica.entries.some(entry => !covered.has(entry.sequence))
    || replica.targets.some(target => target.sequence > replica.sequence)) {
    fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  }
  return replica;
}

export function providerTombstoneReplicaDigest(replica: ProviderTombstoneReplica): string {
  return memoryEffectDigest("tombstone_chain", unsigned(replica));
}

type HeadRow = { provider_instance_id: string; sequence: number; set_root: string; signing_key_id: string; replica_digest: string };

export function verifiedProviderTombstoneHighWater(authority: AuthorityDb): ProviderTombstoneHighWater & {
  readonly provider_instance_id: string | null;
} {
  const heads = authority.db.prepare(
    "SELECT provider_instance_id,sequence,set_root FROM provider_tombstone_replica_heads",
  ).all() as HeadRow[];
  if (heads.length === 0) return { provider_instance_id: null, sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
  if (heads.length !== 1) fail("PROVIDER_TOMBSTONE_REPLICA_AMBIGUOUS");
  const only = heads[0];
  if (only === undefined) fail("PROVIDER_TOMBSTONE_REPLICA_STALE");
  return { provider_instance_id: only.provider_instance_id, ...recomputeStoredHead(authority, only.provider_instance_id) };
}

export function providerTombstoneSuppresses(authority: AuthorityDb,
  identities: readonly string[]): boolean {
  const values = identities.filter(value => value.length > 0);
  if (values.length === 0) return false;
  const marks = values.map(() => "?").join(",");
  const hit = authority.db.prepare(
    `SELECT 1 FROM provider_tombstone_replica_targets WHERE target_digest IN (${marks})
      OR source_identity_digest IN (${marks}) OR content_identity_digest IN (${marks})
      OR citation_identity_digest IN (${marks}) OR subject_identity_digest IN (${marks})
      OR page_content_digest IN (${marks})
     UNION ALL SELECT 1 FROM provider_tombstone_replica_entries WHERE keyed_subject_digest IN (${marks})
     LIMIT 1`,
  ).get(...values, ...values, ...values, ...values, ...values, ...values, ...values);
  return hit !== undefined;
}

