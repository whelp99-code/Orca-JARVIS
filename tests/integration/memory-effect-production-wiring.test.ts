import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { hostMemoryWithdrawalOptions } from "../../src/cli-host-memory.js";
import { createProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import type { MemoryRuntimeLayout } from "../../src/memory-managed-surface-scanner.js";
import { createProductionMemoryWithdrawal,
  type MemoryWithdrawalProductionOptions } from "../../src/memory-withdrawal-production.js";
import { cleanupFixtures, fixture, type Fixture } from "../fixtures/second-brain-transport-harness.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

/**
 * The deployed composition has to sign with the identity the deployment provisioned.
 *
 * An installed provider only honours a read fence naming a key id its own configuration authorizes,
 * so a key minted for this process is not a weaker version of the provisioned one: it is a fence
 * the provider refuses, and the withdrawal, cancellation and deletion behind it fail there. These
 * cases measure what the compositions the deployed `service run`, `memory withdraw-prepare` and the
 * lifecycle sagas actually build put on the wire, against a real stdio provider child.
 */
const KEY_ID = "jarvis:memory-effect:deployment";
const NOW = new Date("2026-08-31T03:30:00.000Z");
const PROVIDER_ID = "provider:task32-v6-qa";
const RECORD_QUERY = "Prefer cited evidence over recollection.";
const CONTRACT = resolve("contracts/second-brain-mcp-v1.json");
const EFFECT_KEY_ID_ENV = "JARVIS_MEMORY_EFFECT_SIGNING_KEY_ID";
const EFFECT_KEY_PATH_ENV = "JARVIS_MEMORY_EFFECT_PRIVATE_KEY_PATH";

const databases: MemoryDatabase[] = [];
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const database of databases.splice(0)) closeMemoryDatabase(database);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupFixtures();
  delete process.env[EFFECT_KEY_ID_ENV];
  delete process.env[EFFECT_KEY_PATH_ENV];
  delete process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  delete process.env["JARVIS_SECOND_BRAIN_CONFIG"];
  delete process.env["JARVIS_MEMORY_PROVIDER_INSTANCE_ID"];
});

/** The key file a deployment provisioned, held the way the service drop-in names it. */
function provisionedKey(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-effect-wiring-key-"));
  roots.push(root);
  const path = join(root, "memory-effect-v1.private.pem");
  writeFileSync(path, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function provisioned(): void {
  process.env[EFFECT_KEY_ID_ENV] = KEY_ID;
  process.env[EFFECT_KEY_PATH_ENV] = provisionedKey();
}

/** The provider this deployment reads through: a real stdio child on the schema-4 contract. */
function installedProvider(): Fixture {
  const value = fixture({ adapterScenario: "schema4", recordArguments: true, contractPath: CONTRACT });
  process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = value.launcher;
  process.env["JARVIS_SECOND_BRAIN_CONFIG"] = value.config;
  return value;
}

/** Every read fence the child was actually sent. */
function fencesSent(value: Fixture): Array<Record<string, unknown>> {
  return readFileSync(value.receipt, "utf8").split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .map(entry => (entry["arguments"] ?? {}) as Record<string, unknown>)
    .map(args => args["read_fence"])
    .filter((fence): fence is Record<string, unknown> => typeof fence === "object" && fence !== null);
}

/** The composition `memory withdraw-prepare` builds, pointed at that child. */
function composed(database: MemoryDatabase, child: Fixture,
  overrides: Partial<MemoryWithdrawalProductionOptions> = {}) {
  return createProductionMemoryWithdrawal(database.authority, {
    provider_instance_id: PROVIDER_ID, clock: () => NOW,
    transport_options: { launcherPath: child.launcher, configPath: child.config },
    ...overrides });
}

async function lifecycleRuntime(): Promise<{ runtime: AuthorityDatabaseRuntime; layout: MemoryRuntimeLayout }> {
  const database = await memoryDatabase(); databases.push(database);
  const root = mkdtempSync(join(tmpdir(), "jarvis-effect-wiring-lifecycle-")); roots.push(root);
  const layout: MemoryRuntimeLayout = { spool_root: join(root, "spool"),
    state_root: join(root, "state"), dist_root: join(root, "dist"),
    backup_root: join(root, "backups"), restore_root: join(root, "restore") };
  for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const runtime = new AuthorityDatabaseRuntime(database.authority,
    { registry_root: join(root, "registry"), watchdog_ms: 10_000 });
  return { runtime, layout };
}

function lifecycle(runtime: AuthorityDatabaseRuntime, layout: MemoryRuntimeLayout, child: Fixture) {
  return createProductionMemoryLifecycleService(runtime, {
    provider_instance_id: PROVIDER_ID, launcher_path: child.launcher,
    provider_config_path: child.config, contract_path: CONTRACT,
    subject_key: Buffer.alloc(32, 11), layout, clock: () => NOW });
}

describe("the deployed memory-effect composition signs with the provisioned identity", () => {
  it("puts the provisioned key id on every fence it sends the provider", async () => {
    const child = installedProvider();
    provisioned();
    const database = await memoryDatabase(); databases.push(database);
    const runtime = composed(database, child);
    closers.push(() => runtime.close());
    await runtime.reader.search(RECORD_QUERY);
    const fences = fencesSent(child);
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) expect(fence["signing_key_id"]).toBe(KEY_ID);
  });

  it("refuses to compose a withdrawal for a configured provider when no key was provisioned", async () => {
    const child = installedProvider();
    const database = await memoryDatabase(); databases.push(database);
    expect(() => composed(database, child)).toThrow("MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED");
    // Refused before the provider was reached, so no key minted here ever signed a fence.
    expect(readFileSync(child.receipt, "utf8")).toBe("");
  });

  it("refuses to compose the lifecycle sagas when no key was provisioned", async () => {
    const child = installedProvider();
    const { runtime, layout } = await lifecycleRuntime();
    expect(() => lifecycle(runtime, layout, child)).toThrow("MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED");
    expect(readFileSync(child.receipt, "utf8")).toBe("");
  });

  it("composes the lifecycle sagas on the provisioned identity", async () => {
    const child = installedProvider();
    provisioned();
    const { runtime, layout } = await lifecycleRuntime();
    const service = lifecycle(runtime, layout, child);
    closers.push(() => service.close());
    expect(service).toBeDefined();
  });

  it("keeps the explicit fixture signer a test composition passes", async () => {
    const child = installedProvider();
    const database = await memoryDatabase(); databases.push(database);
    const runtime = composed(database, child, { signing_key_id: "memory-effect-fixture",
      private_key: generateKeyPairSync("ed25519").privateKey });
    closers.push(() => runtime.close());
    await runtime.reader.search(RECORD_QUERY);
    const fences = fencesSent(child);
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) expect(fence["signing_key_id"]).toBe("memory-effect-fixture");
  });

  it("refuses a half-injected signer instead of falling back to the provisioned key", async () => {
    const child = installedProvider();
    provisioned();
    const database = await memoryDatabase(); databases.push(database);
    expect(() => composed(database, child, { signing_key_id: "memory-effect-fixture" }))
      .toThrow("MEMORY_WITHDRAWAL_CONFIG_INVALID");
  });

  it("names no signing material in the host composition, and refuses without a provisioned key", async () => {
    const child = installedProvider();
    process.env["JARVIS_MEMORY_PROVIDER_INSTANCE_ID"] = PROVIDER_ID;
    const host = hostMemoryWithdrawalOptions();
    expect(host).toEqual({ provider_instance_id: PROVIDER_ID,
      transport_options: { launcherPath: child.launcher, configPath: child.config } });
    const database = await memoryDatabase(); databases.push(database);
    expect(() => createProductionMemoryWithdrawal(database.authority, { ...host!, clock: () => NOW }))
      .toThrow("MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED");
  });

  it("offers no host composition when the deployment names no provider", () => {
    expect(hostMemoryWithdrawalOptions({})).toBeUndefined();
    expect(hostMemoryWithdrawalOptions({ JARVIS_SECOND_BRAIN_LAUNCHER: "/opt/second-brain-mcp" }))
      .toBeUndefined();
    expect(hostMemoryWithdrawalOptions({ JARVIS_MEMORY_PROVIDER_INSTANCE_ID: PROVIDER_ID }))
      .toBeUndefined();
  });
});
