import { randomUUID, type KeyObject } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { createMemoryReadFence, MEMORY_TOMBSTONE_GENESIS_ROOT, type MemoryReadFenceV1 } from "./second-brain-effect-v2.js";

export type MemoryReadFenceIdentity = {
  readonly provider_instance_id: string; readonly signing_key_id: string; readonly private_key: KeyObject;
  readonly fence_ttl_ms?: number; readonly nonce?: () => string;
};
export function memoryReadHighWater(authority: AuthorityDb) {
  const row = authority.db.prepare("SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1")
    .get() as { sequence: number; set_root: string } | undefined;
  return row ?? { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
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
