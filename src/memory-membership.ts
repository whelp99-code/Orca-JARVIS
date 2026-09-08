import { createHmac } from "node:crypto";
import type { MemoryMembership } from "./memory-read-privacy.js";

/** Same persistent key/domain as existing outward memory token membership. */
export function createMemoryMembership(key: Buffer): MemoryMembership {
  if (key.byteLength !== 32) throw new TypeError("MEMORY_TOKEN_CONFIG_INVALID");
  const pinned = Buffer.from(key);
  return (kind, value) => `hmac-sha256:${createHmac("sha256", pinned)
    .update(`orca-jarvis/memory-membership-${kind}/v1\0`).update(value).digest("hex")}`;
}
