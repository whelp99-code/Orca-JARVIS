import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { createProductionMemoryReadFence } from "../../src/memory-read-fence-production.js";
import { createProductionMemoryOutbox } from "../../src/memory-outbox-production.js";
import { bindDashboardMemoryDependencies } from "../../src/dashboard/memory-production.js";
import { MEMORY_READ_FENCE_SIGNATURE_DOMAIN, type MemoryReadFenceV1 } from "../../src/second-brain-effect-v2.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { OUTBOX_NOW, outboxFixture, claimAction } from "../fixtures/memory-outbox-fixture.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

const databases: MemoryDatabase[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const db of databases.splice(0)) closeMemoryDatabase(db); });
async function fixture(expires?: string) {
  const database = await memoryDatabase(); databases.push(database);
  return { database, ...memoryReadFenceFixture(database, expires) };
}
function environment(config: ReturnType<typeof memoryReadFenceFixture>["config"]) {
  vi.stubEnv("JARVIS_MEMORY_PROVIDER_INSTANCE_ID", config.provider_instance_id);
  vi.stubEnv("JARVIS_MEMORY_SIGNING_KEY_ID", config.signing_key_id);
  vi.stubEnv("JARVIS_MEMORY_PRIVATE_KEY_PATH", config.private_key_path);
}
const transport = (): SecondBrainTransport => ({ call: vi.fn<SecondBrainTransport["call"]>(async () => ({ kind: "no_data", reason: "empty_result" })),
  close: vi.fn(async () => {}), restart: async () => {}, diagnostics: () => [] });

describe("production signed memory read fences", () => {
  it("preserves long provider and dotted key IDs from the existing canonical text contract", async () => {
    const database = await memoryDatabase(); databases.push(database);
    const identity = { provider_instance_id: `provider:${"p".repeat(128)}`, signing_key_id: "jarvis.keys/owner.v1" };
    const { config } = memoryReadFenceFixture(database, undefined, identity);
    expect(createProductionMemoryReadFence(database.authority, config)!(OUTBOX_NOW)).toMatchObject(identity);
  });

  it("binds each dashboard outbox to its own database key state", async () => {
    const a = await fixture(); const b = await outboxFixture(); databases.push(b.database);
    memoryReadFenceFixture(b.database);
    const provider = transport();
    const dashboard = bindDashboardMemoryDependencies(a.database.authority, { providerTransport: provider,
      memoryReadFenceConfig: a.config,
      memoryCandidateReviewSpoolRoot: join(b.database.root, "candidate-review"),
      memoryCandidateDispatchSpoolRoot: join(b.database.root, "candidate-dispatch"),
      memoryAdapterOptions: { clock: () => OUTBOX_NOW, contract_profile: "schema4", max_age_ms: 86_400_000,
        expiry_ms: 172_800_000, budgets: { max_hits: 8, max_excerpt_bytes: 1024, max_total_bytes: 65536, max_page_bytes: 65536 } } });
    await dashboard.memoryAdapter!.readPage("wiki/fixture");
    expect(provider.call).toHaveBeenCalledTimes(1); vi.mocked(provider.call).mockClear();
    const outbox = dashboard.outboxFor(b.database.authority)!;
    const queued = outbox.enqueue(claimAction(b));
    revokeMemoryEffectDelegationKey(b.database.authority, a.config.signing_key_id);
    await outbox.runOnce("other-database", 1);
    expect(vi.mocked(provider.call).mock.calls.map(call => call[0])).toEqual(["sb_write_request"]);
    expect(outbox.get(queued.outbox_id)?.state).toBe("reconciling");
  });
  it("uses explicit configuration, signs a verifiable owner read, and caps TTL at key expiry", async () => {
    const f = await fixture(new Date(OUTBOX_NOW.getTime() + 30_000).toISOString());
    const factory = createProductionMemoryReadFence(f.database.authority, f.config)!;
    const signed = factory(OUTBOX_NOW); const { signature, ...body } = signed;
    expect(signed).toMatchObject({ provider_instance_id: "provider:fixture", principal_id: "principal:owner",
      signing_key_id: "jarvis:fixture", purpose: "memory_read", operation: "read", tombstone_sequence: 0,
      expires_at: new Date(OUTBOX_NOW.getTime() + 30_000).toISOString() });
    expect(verify(null, Buffer.from(MEMORY_READ_FENCE_SIGNATURE_DOMAIN + canonicalize(body)),
      f.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(factory(OUTBOX_NOW).nonce).not.toBe(signed.nonce);
    expect(() => factory(new Date(OUTBOX_NOW.getTime() + 30_000))).toThrow("MEMORY_READ_FENCE_KEY_UNAVAILABLE");
    revokeMemoryEffectDelegationKey(f.database.authority, f.config.signing_key_id);
    expect(() => factory(OUTBOX_NOW)).toThrow("MEMORY_READ_FENCE_KEY_UNAVAILABLE");
  });

  it("connects environment configuration to both dashboard and outbox readers without a callback", async () => {
    const f = await fixture(); environment(f.config); const provider = transport();
    const runtime = createProductionMemoryOutbox(f.database.authority, { transport: provider, clock: () => OUTBOX_NOW });
    await runtime.reader.readPage("wiki/fixture");
    const dashboard = bindDashboardMemoryDependencies(f.database.authority, { providerTransport: provider,
      memoryAdapterOptions: { clock: () => OUTBOX_NOW, contract_profile: "schema4", max_age_ms: 86_400_000,
        expiry_ms: 172_800_000, budgets: { max_hits: 8, max_excerpt_bytes: 1024, max_total_bytes: 65536, max_page_bytes: 65536 } } });
    await dashboard.memoryAdapter!.readPage("wiki/fixture");
    expect(provider.call).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(provider.call).mock.calls) expect(call[1]).toMatchObject({
      read_fence: { purpose: "memory_read", provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture" } });
    await runtime.close(); expect(provider.close).not.toHaveBeenCalled();
  });

  it("returns an adapter failure with zero frames after key revocation instead of throwing or sending an unfenced read", async () => {
    const f = await fixture(); const provider = transport();
    const runtime = createProductionMemoryOutbox(f.database.authority, {
      transport: provider, clock: () => OUTBOX_NOW, read_fence_config: f.config });
    revokeMemoryEffectDelegationKey(f.database.authority, f.config.signing_key_id);
    await expect(runtime.reader.readPage("wiki/fixture")).resolves.toMatchObject({ kind: "invalid", code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" });
    expect(provider.call).not.toHaveBeenCalled();
  });

  it.each(["missing", "partial", "empty"] as const)("handles %s environment configuration explicitly", async mode => {
    const f = await fixture();
    for (const name of ["JARVIS_MEMORY_PROVIDER_INSTANCE_ID", "JARVIS_MEMORY_SIGNING_KEY_ID", "JARVIS_MEMORY_PRIVATE_KEY_PATH"]) vi.stubEnv(name, undefined);
    if (mode === "missing") expect(createProductionMemoryReadFence(f.database.authority)).toBeUndefined();
    else {
      vi.stubEnv("JARVIS_MEMORY_PROVIDER_INSTANCE_ID", mode === "partial" ? "provider:fixture" : "");
      expect(() => createProductionMemoryReadFence(f.database.authority)).toThrow("MEMORY_READ_FENCE_CONFIG_INVALID");
    }
  });

  it.each(["permissions", "symlink", "oversize", "wrong-algorithm", "wrong-key", "missing-registration"] as const)(
    "rejects %s key material", async mode => {
      const f = await fixture(); let config = f.config;
      if (mode === "permissions") chmodSync(config.private_key_path, 0o644);
      if (mode === "symlink") {
        const link = join(f.database.root, "link.pem"); symlinkSync(config.private_key_path, link);
        config = { ...config, private_key_path: link };
      }
      if (mode === "oversize") writeFileSync(config.private_key_path, Buffer.alloc(16_385));
      if (mode === "wrong-algorithm" || mode === "wrong-key") {
        const key = mode === "wrong-key" ? generateKeyPairSync("ed25519").privateKey
          : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
        writeFileSync(config.private_key_path, key.export({ type: "pkcs8", format: "pem" }));
        expect(createPublicKey(key).asymmetricKeyType).toBe(mode === "wrong-key" ? "ed25519" : "ec");
      }
      if (mode === "missing-registration") config = { ...config, signing_key_id: "unregistered" };
      if (mode === "wrong-key" || mode === "missing-registration") {
        expect(() => createProductionMemoryReadFence(f.database.authority, config)!(OUTBOX_NOW)).toThrow("MEMORY_READ_FENCE_KEY_UNAVAILABLE");
      } else expect(() => createProductionMemoryReadFence(f.database.authority, config)).toThrow("MEMORY_READ_FENCE_CONFIG_INVALID");
    });

  it("preserves an explicit injected read fence without loading environment keys", async () => {
    const f = await fixture(); const provider = transport();
    vi.stubEnv("JARVIS_MEMORY_PRIVATE_KEY_PATH", "/missing.pem");
    const custom = createProductionMemoryReadFence(f.database.authority, f.config)!(OUTBOX_NOW);
    const runtime = createProductionMemoryOutbox(f.database.authority, { transport: provider, clock: () => OUTBOX_NOW,
      read_fence: () => custom as MemoryReadFenceV1 });
    await runtime.reader.readPage("wiki/fixture");
    expect(provider.call).toHaveBeenCalledWith("sb_read_page", { id: "wiki/fixture", read_fence: custom });
  });
});
