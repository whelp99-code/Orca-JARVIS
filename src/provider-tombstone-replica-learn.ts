import type { KeyObject } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { type MemoryTombstoneChainEntryV2 } from "./second-brain-effect-v2.js";
import {
  providerTombstoneReplicaDigest, verifyProviderTombstoneChain, verifyProviderTombstoneReplica,
  type ProviderTombstoneHighWater,
} from "./provider-tombstone-replica.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function fail(code: string): never {
  throw new JarvisError(code, code);
}
type EntryRow = MemoryTombstoneChainEntryV2 & { provider_instance_id: string };
type HeadRow = { sequence: number; set_root: string; signing_key_id: string; replica_digest: string };

export function learnProviderTombstoneReplica(authority: AuthorityDb, value: unknown,
  keys: ReadonlyMap<string, KeyObject | string>, learnedAt: string,
  expectedProvider?: string): ProviderTombstoneHighWater {
  if (!INSTANT.test(learnedAt)) fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  const replica = verifyProviderTombstoneReplica(value, keys);
  if (expectedProvider !== undefined && replica.provider_instance_id !== expectedProvider) {
    fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  }
  const digest = providerTombstoneReplicaDigest(replica);
  return authority.db.transaction(() => {
    const head = authority.db.prepare(
      "SELECT sequence,set_root,signing_key_id,replica_digest FROM provider_tombstone_replica_heads WHERE provider_instance_id=?",
    ).get(replica.provider_instance_id) as { sequence: number; set_root: string; signing_key_id: string; replica_digest: string } | undefined;
    if (head !== undefined) {
      if (head.sequence === replica.sequence && head.set_root === replica.set_root && head.replica_digest === digest) {
        return { sequence: head.sequence, set_root: head.set_root };
      }
      if (head.signing_key_id !== replica.signing_key_id || replica.sequence <= head.sequence) {
        fail("PROVIDER_TOMBSTONE_REPLICA_CONFLICT");
      }
      const prefix = authority.db.prepare(
        "SELECT set_root FROM provider_tombstone_replica_entries WHERE provider_instance_id=? AND sequence=?",
      ).get(replica.provider_instance_id, head.sequence) as { set_root: string } | undefined;
      if (prefix?.set_root !== head.set_root || replica.entries[head.sequence - 1]?.set_root !== head.set_root) {
        fail("PROVIDER_TOMBSTONE_REPLICA_CONFLICT");
      }
    } else {
      authority.db.prepare(
        `INSERT INTO provider_tombstone_replica_heads(
          provider_instance_id,sequence,set_root,signing_key_id,replica_digest,learned_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(replica.provider_instance_id, replica.sequence, replica.set_root, replica.signing_key_id, digest, learnedAt);
    }
    const insertEntry = authority.db.prepare(
      `INSERT INTO provider_tombstone_replica_entries(
        provider_instance_id,sequence,tombstone_id,operation,lane_id,target_manifest_digest,scope_digest,
        authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,previous_root,set_root)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const entry of replica.entries) {
      if (head !== undefined && entry.sequence <= head.sequence) continue;
      insertEntry.run(replica.provider_instance_id, entry.sequence, entry.tombstone_id, entry.operation, entry.lane_id,
        entry.target_manifest_digest, entry.scope_digest, entry.authority_receipt_digest, entry.payload_digest,
        entry.keyed_subject_digest, entry.effective_at, entry.previous_root, entry.set_root);
    }
    const insertTarget = authority.db.prepare(
      `INSERT INTO provider_tombstone_replica_targets(
        provider_instance_id,sequence,target_digest,source_identity_digest,content_identity_digest,
        citation_identity_digest,subject_identity_digest,page_content_digest)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const target of replica.targets) {
      if (head !== undefined && target.sequence <= head.sequence) continue;
      insertTarget.run(replica.provider_instance_id, target.sequence, target.target_digest, target.source_identity_digest,
        target.content_identity_digest, target.citation_identity_digest, target.subject_identity_digest, target.page_content_digest);
    }
    if (head !== undefined) {
      authority.db.prepare(
        `UPDATE provider_tombstone_replica_heads SET sequence=?,set_root=?,replica_digest=?,learned_at=?
         WHERE provider_instance_id=?`,
      ).run(replica.sequence, replica.set_root, digest, learnedAt, replica.provider_instance_id);
    }
    return recomputeStoredHead(authority, replica.provider_instance_id);
  })();
}

export function recomputeStoredHead(authority: AuthorityDb, provider: string): ProviderTombstoneHighWater {
  const rows = authority.db.prepare(
    `SELECT sequence,tombstone_id,operation,lane_id,target_manifest_digest,scope_digest,authority_receipt_digest,
      payload_digest,keyed_subject_digest,effective_at,previous_root,set_root
     FROM provider_tombstone_replica_entries WHERE provider_instance_id=? ORDER BY sequence`,
  ).all(provider) as EntryRow[];
  const head = authority.db.prepare(
    "SELECT sequence,set_root,signing_key_id,replica_digest FROM provider_tombstone_replica_heads WHERE provider_instance_id=?",
  ).get(provider) as HeadRow | undefined;
  if (head === undefined) fail("PROVIDER_TOMBSTONE_REPLICA_STALE");
  const verified = verifyProviderTombstoneChain(rows, head);
  const targets = authority.db.prepare(
    "SELECT sequence FROM provider_tombstone_replica_targets WHERE provider_instance_id=?",
  ).all(provider) as Array<{ sequence: number }>;
  const covered = new Set(targets.map(target => target.sequence));
  if (rows.some(entry => !covered.has(entry.sequence))) fail("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  if (!DIGEST.test(head.replica_digest) || head.signing_key_id.length === 0) fail("PROVIDER_TOMBSTONE_REPLICA_STALE");
  return verified;
}

/** Verified provider head, or genesis when this authority has not learned one.
 * Never returns a head that was not recomputed from stored links. */
