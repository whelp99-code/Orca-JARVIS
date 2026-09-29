import { randomUUID, type KeyObject } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { verifiedProviderTombstoneHighWater } from "./provider-tombstone-replica.js";
import { createMemoryReadFence, MEMORY_TOMBSTONE_GENESIS_ROOT, type MemoryReadFenceV1 } from "./second-brain-effect-v2.js";

export type MemoryReadFenceIdentity = {
  readonly provider_instance_id: string; readonly signing_key_id: string; readonly private_key: KeyObject;
  readonly fence_ttl_ms?: number; readonly nonce?: () => string;
};
export function localTombstoneHighWater(authority: AuthorityDb) {
  const row = authority.db.prepare("SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1")
    .get() as { sequence: number; set_root: string } | undefined;
  return row ?? { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
}
/** Fence head Second Brain expects: the provider replica, once its links recompute, else the local chain.
 * A provider head is never echoed unless those stored links verify. Divergent local and provider chains
 * stay on the local head so a reader cannot claim the other root. */
export function memoryReadHighWater(authority: AuthorityDb) {
  const local = localTombstoneHighWater(authority);
  const provider = verifiedProviderTombstoneHighWater(authority);
  if (provider.provider_instance_id === null || provider.sequence === 0) return local;
  if (local.sequence === 0) return { sequence: provider.sequence, set_root: provider.set_root };
  const prefix = authority.db.prepare(
    "SELECT set_root FROM provider_tombstone_replica_entries WHERE provider_instance_id=? AND sequence=?",
  ).get(provider.provider_instance_id, local.sequence) as { set_root: string } | undefined;
  if (prefix?.set_root === local.set_root && provider.sequence >= local.sequence) {
    return { sequence: provider.sequence, set_root: provider.set_root };
  }
  return local;
}
export function signMemoryReadFence(identity: MemoryReadFenceIdentity,
  purpose: MemoryReadFenceV1["purpose"], high: { sequence: number; set_root: string }, at: Date): MemoryReadFenceV1 {
  const ttl = identity.fence_ttl_ms ?? 60_000; const now = at.getTime();
  if (!identity.provider_instance_id || !identity.signing_key_id || identity.private_key.asymmetricKeyType !== "ed25519"
    || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300_000 || !Number.isFinite(now)) {
    throw new JarvisError("MEMORY_READ_FENCE_INVALID");
  }
  const stamp = at.toISOString();
  return createMemoryReadFence({ provider_instance_id: identity.provider_instance_id, purpose,
    operation: purpose === "memory_read" ? "read" : purpose === "memory_status" ? "status" : "resolve",
    tombstone_sequence: high.sequence, tombstone_set_root: high.set_root, issued_at: stamp, not_before: stamp,
    expires_at: new Date(now + ttl).toISOString(), nonce: `memfence-nonce:${identity.nonce?.() ?? randomUUID()}`,
    signing_key_id: identity.signing_key_id }, identity.private_key);
}
/** Refuse a fence whose tip was not recomputed from a chain this authority has recorded. */
export function signObservedMemoryReadFence(authority: AuthorityDb, identity: MemoryReadFenceIdentity,
  purpose: MemoryReadFenceV1["purpose"], high: { sequence: number; set_root: string }, at: Date): MemoryReadFenceV1 {
  const observed = memoryReadHighWater(authority);
  if (high.sequence !== observed.sequence || high.set_root !== observed.set_root) {
    throw new JarvisError("MEMORY_READ_FENCE_UNVERIFIED_HEAD");
  }
  return signMemoryReadFence(identity, purpose, observed, at);
}
