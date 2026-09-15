import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionSecondBrainEffectService,
  readMemoryEffectSigningIdentity } from "../../src/second-brain-effect-service-production.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { MemoryReferenceProvider, REFERENCE_GENERATION,
  REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

// The identity an operational deployment provisions on both sides: the provider's configuration
// authorizes this key id, and this is the key file it authorized.
const KEY_ID = "jarvis:memory-effect:deployment";
const NOW = new Date("2026-08-31T03:30:00.000Z");
const databases: MemoryDatabase[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) closeMemoryDatabase(database);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.JARVIS_MEMORY_EFFECT_SIGNING_KEY_ID;
  delete process.env.JARVIS_MEMORY_EFFECT_PRIVATE_KEY_PATH;
});

function provisioned(mode = 0o600): { path: string; publicKey: KeyObject } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-memory-effect-key-"));
  roots.push(root);
  const pair = generateKeyPairSync("ed25519");
  const path = join(root, "jarvis-memory-effect.key");
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode });
  chmodSync(path, mode);
  return { path, publicKey: createPublicKey(pair.privateKey) };
}

/** A provider that knows only the deployment's key id, as an installed provider does. */
function providerKnowing(publicKey: KeyObject): MemoryReferenceProvider {
  const transport = new MemoryReferenceProvider();
  transport.authorizedFenceKeys = new Map([[KEY_ID, publicKey]]);
  return transport;
}

async function resolve(transport: MemoryReferenceProvider, service: SecondBrainEffectService) {
  void transport;
  return service.resolveTarget({ record_id: REFERENCE_RECORD.record_id,
    record_digest: REFERENCE_RECORD.record_digest, generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest });
}

describe("the production effect service signs with the deployment's provisioned key", () => {
  it("resolves a target through a provider that knows only that key id", async () => {
    const database = await memoryDatabase(); databases.push(database);
    const key = provisioned();
    const transport = providerKnowing(key.publicKey);
    const service = createProductionSecondBrainEffectService({ authority: database.authority, transport,
      writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
      provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
      signing: { signing_key_id: KEY_ID, private_key_path: key.path } });
    expect(await resolve(transport, service)).toMatchObject({ kind: "data" });
    const fence = transport.calls.at(-1)?.args["read_fence"] as Record<string, unknown>;
    expect(fence["signing_key_id"]).toBe(KEY_ID);
  });

  it("reads the same identity from the deployment environment", async () => {
    const database = await memoryDatabase(); databases.push(database);
    const key = provisioned();
    process.env.JARVIS_MEMORY_EFFECT_SIGNING_KEY_ID = KEY_ID;
    process.env.JARVIS_MEMORY_EFFECT_PRIVATE_KEY_PATH = key.path;
    const transport = providerKnowing(key.publicKey);
    const service = createProductionSecondBrainEffectService({ authority: database.authority, transport,
      writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
      provider_instance_id: REFERENCE_GENERATION.provider_instance_id });
    expect(await resolve(transport, service)).toMatchObject({ kind: "data" });
  });

  it("refuses to exist when the deployment provisioned no memory-effect key", () => {
    expect(() => readMemoryEffectSigningIdentity())
      .toThrow("MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED");
  });

  it.each([
    ["a key id without a path", { signing_key_id: KEY_ID, private_key_path: undefined }],
    ["a relative path", { signing_key_id: KEY_ID, private_key_path: "keys/effect.key" }],
    ["an empty key id", { signing_key_id: "", private_key_path: "/keys/effect.key" }],
  ])("refuses a half-configured identity (%s)", (_name, signing) => {
    expect(() => readMemoryEffectSigningIdentity(signing as never))
      .toThrow("MEMORY_EFFECT_SIGNING_KEY_INVALID");
  });

  it("refuses a configured key file it cannot read as a private Ed25519 key", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-memory-effect-key-")); roots.push(root);
    const path = join(root, "not-a-key.pem");
    writeFileSync(path, "not a key\n", { mode: 0o600 });
    expect(() => readMemoryEffectSigningIdentity({ signing_key_id: KEY_ID, private_key_path: path }))
      .toThrow("MEMORY_EFFECT_SIGNING_KEY_INVALID");
  });

  it("refuses a provisioned key file other users can read", () => {
    const key = provisioned(0o644);
    expect(() => readMemoryEffectSigningIdentity({ signing_key_id: KEY_ID, private_key_path: key.path }))
      .toThrow("MEMORY_EFFECT_SIGNING_KEY_INVALID");
  });

  it("shows why an ephemeral per-process key cannot reach a real provider", async () => {
    const database = await memoryDatabase(); databases.push(database);
    const key = provisioned();
    const transport = providerKnowing(key.publicKey);
    const service = new SecondBrainEffectService({ authority: database.authority, transport,
      writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
      provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
      signing_key_id: "memory-effect-packaged", private_key: generateKeyPairSync("ed25519").privateKey });
    expect(await resolve(transport, service))
      .toEqual({ kind: "unavailable", code: "TOMBSTONE_FENCE_REQUIRED" });
  });

  it("refuses a fence signed by an unprovisioned key even under the provisioned key id", async () => {
    const database = await memoryDatabase(); databases.push(database);
    const key = provisioned();
    const transport = providerKnowing(key.publicKey);
    const service = new SecondBrainEffectService({ authority: database.authority, transport,
      writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
      provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
      signing_key_id: KEY_ID, private_key: generateKeyPairSync("ed25519").privateKey });
    expect(await resolve(transport, service))
      .toEqual({ kind: "unavailable", code: "TOMBSTONE_FENCE_REQUIRED" });
  });
});
