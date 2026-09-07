import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import type { MemoryDatabase } from "./memory-candidate-store.js";
import { OUTBOX_NOW } from "./memory-outbox-fixture.js";

export function memoryReadFenceFixture(database: MemoryDatabase, expires = "2026-09-01T03:30:00.000Z",
  identity: { provider_instance_id?: string; signing_key_id?: string } = {}) {
  const key = createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  ]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key);
  const config = { provider_instance_id: identity.provider_instance_id ?? "provider:fixture",
    signing_key_id: identity.signing_key_id ?? "jarvis:fixture",
    private_key_path: join(database.root, "memory-read-fixture.pem") };
  writeFileSync(config.private_key_path, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  registerMemoryEffectDelegationKey(database.authority, { key_id: config.signing_key_id,
    principal_id: "principal:owner", public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    valid_from: OUTBOX_NOW.toISOString(), valid_until: expires }, OUTBOX_NOW);
  return { config, key, publicKey };
}
