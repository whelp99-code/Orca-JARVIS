import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { isAbsolute } from "node:path";
import { JarvisError, type AuthorityDb } from "./db.js";
import { readEd25519PrivateKeyFile } from "./memory-signing-key-file.js";
import { memoryReadHighWater, signObservedMemoryReadFence } from "./memory-read-fence.js";
import type { MemoryReadFenceV1 } from "./second-brain-effect-v2.js";
import type { SecondBrainAdapterOptions } from "./second-brain-adapter-types.js";

export type MemoryReadFenceProductionConfig = {
  readonly provider_instance_id: string;
  readonly signing_key_id: string;
  readonly private_key_path: string;
};
const invalid = (): never => { throw new JarvisError("MEMORY_READ_FENCE_CONFIG_INVALID"); };
function configuration(explicit?: MemoryReadFenceProductionConfig): MemoryReadFenceProductionConfig | undefined {
  const values = explicit ?? { provider_instance_id: process.env.JARVIS_MEMORY_PROVIDER_INSTANCE_ID,
    signing_key_id: process.env.JARVIS_MEMORY_SIGNING_KEY_ID,
    private_key_path: process.env.JARVIS_MEMORY_PRIVATE_KEY_PATH };
  if (explicit === undefined && Object.values(values).every(value => value === undefined)) return undefined;
  if (typeof values.provider_instance_id !== "string" || values.provider_instance_id.length === 0
    || values.provider_instance_id !== values.provider_instance_id.normalize("NFC")
    || typeof values.signing_key_id !== "string" || values.signing_key_id.length === 0
    || values.signing_key_id !== values.signing_key_id.normalize("NFC")
    || typeof values.private_key_path !== "string" || !isAbsolute(values.private_key_path)) return invalid();
  return values as MemoryReadFenceProductionConfig;
}
function privateKey(path: string): KeyObject {
  return readEd25519PrivateKeyFile(path) ?? invalid();
}

/** Reads existing configuration and authority only. Never generates or registers keys,
 * copies a provider high-water, or grants a memory write capability. */
export function createProductionMemoryReadAuthorization(authority: AuthorityDb, explicit?: MemoryReadFenceProductionConfig,
  purpose: "memory_read" | "memory_status" = "memory_read"):
  ((at: Date) => { readonly fence: MemoryReadFenceV1; readonly private_key: KeyObject }) | undefined {
  const config = configuration(explicit); if (config === undefined) return undefined;
  const key = privateKey(config.private_key_path);
  const fingerprint = `sha256:${createHash("sha256").update(createPublicKey(key)
    .export({ format: "der", type: "spki" })).digest("hex")}`;
  return at => {
    try {
      const row = authority.db.prepare(
        `SELECT principal_id,algorithm,key_fingerprint,state,valid_from,valid_until
         FROM memory_effect_delegation_keys WHERE key_id=?`,
      ).get(config.signing_key_id) as { principal_id: string; algorithm: string; key_fingerprint: string;
        state: string; valid_from: string; valid_until: string } | undefined;
      if (!Number.isFinite(at.getTime()) || row === undefined || row.principal_id !== "principal:owner"
        || row.algorithm !== "Ed25519" || row.state !== "active" || row.key_fingerprint !== fingerprint
        || !(Date.parse(row.valid_from) <= at.getTime() && at.getTime() < Date.parse(row.valid_until))) {
        throw new JarvisError("MEMORY_READ_FENCE_KEY_UNAVAILABLE");
      }
      const fence = signObservedMemoryReadFence(authority, { ...config, private_key: key,
        fence_ttl_ms: Math.min(60_000, Date.parse(row.valid_until) - at.getTime()) },
      purpose, memoryReadHighWater(authority), at);
      return { fence, private_key: key };
    } catch (error) {
      if (error instanceof JarvisError && error.code === "MEMORY_READ_FENCE_KEY_UNAVAILABLE") throw error;
      throw new JarvisError("MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE");
    }
  };
}

export function createProductionMemoryReadFence(authority: AuthorityDb, explicit?: MemoryReadFenceProductionConfig,
  purpose: "memory_read" | "memory_status" = "memory_read"): SecondBrainAdapterOptions["read_fence"] {
  const authorize = createProductionMemoryReadAuthorization(authority, explicit, purpose);
  return authorize === undefined ? undefined : at => authorize(at).fence;
}
