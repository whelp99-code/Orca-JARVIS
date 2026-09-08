import { chmodSync, existsSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as transportFactory from "../../src/second-brain-transport.js";
import { createProductionMemoryReference, readMemoryReferenceProjectionKey } from "../../src/memory-reference-production.js";
import { execute } from "../../src/cli-runtime.mjs";
import { canonicalize } from "../../src/canonical.js";
import { createMemoryMembership } from "../../src/memory-membership.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createProductionMemoryReadFence } from "../../src/memory-read-fence-production.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { MemoryReferenceProvider, REFERENCE_NOW, REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

// Keep real filesystem behavior while allowing scoped close failure injection.
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const databases: MemoryDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) closeMemoryDatabase(db); });
const budgets = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
async function fixture(expires?: string) {
  const database = await memoryDatabase(); databases.push(database);
  const transport = new MemoryReferenceProvider();
  const { config } = memoryReadFenceFixture(database, expires);
  const options = { transport, read_fence_config: config, projection_key: Buffer.alloc(32, 7), clock: () => REFERENCE_NOW };
  const runtime = createProductionMemoryReference(database.authority, options);
  return { database, transport, options, runtime };
}

describe("policy-bound reference reads", () => {
  it("reads actual adapter records with separate read/status signed fence purposes", async () => {
    const value = await fixture();
    const result = await value.runtime.reader.read("기억", budgets);
    expect(result.payload.records[0]?.text).toBe(REFERENCE_RECORD.record_text);
    expect(result.payload.records[0]?.record.record_id).toBe(REFERENCE_RECORD.record_id);
    expect(value.transport.calls.map(call => call.method)).toEqual([
      "sb_generation_status", "sb_search", "sb_read_page", "sb_generation_status"]);
    for (const call of value.transport.calls) expect(call.args["read_fence"]).toMatchObject({
      purpose: call.method === "sb_generation_status" ? "memory_status" : "memory_read",
      operation: call.method === "sb_generation_status" ? "status" : "read", principal_id: "principal:owner" });
    await value.runtime.close();
    expect(value.transport.closed).toBe(false); // Injected transport stays caller-owned.
  });
  it("rejects a local privacy change during the provider query", async () => {
    const value = await fixture();
    value.transport.onCall = method => {
      if (method === "sb_search") value.database.authority.db.prepare(
        "UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1,policy_digest='changed' WHERE singleton_id=1").run();
    };
    await expect(value.runtime.reader.read("기억", budgets)).rejects.toMatchObject({ code: "MEMORY_REFERENCE_PRIVACY_CHANGED" });
  });
  it("checks policy changes during transport cleanup before preparing any body", async () => {
    const value = await fixture();
    await expect(value.runtime.reader.read("기억", budgets, async () => {
      value.database.authority.db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
    })).rejects.toMatchObject({ code: "MEMORY_REFERENCE_PRIVACY_CHANGED" });
  });
  it("returns a stable error for missing privacy state without exposing SQL or making an RPC", async () => {
    const value = await fixture();
    value.database.authority.db.prepare("DELETE FROM memory_surface_authority").run();
    await expect(value.runtime.reader.read("기억", budgets))
      .rejects.toMatchObject({ code: "MEMORY_REFERENCE_PRIVACY_UNAVAILABLE", message: "MEMORY_REFERENCE_PRIVACY_UNAVAILABLE" });
    expect(value.transport.calls).toHaveLength(0);
  });
  it("rolls back privacy revisions with their source writes and prevents revision reset", async () => {
    const value = await fixture(); const db = value.database.authority.db;
    const before = db.prepare("SELECT revision FROM memory_read_revision").get();
    expect(() => db.transaction(() => {
      db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
      throw new Error("abort fixture");
    })()).toThrow("abort fixture");
    expect(db.prepare("SELECT revision FROM memory_read_revision").get()).toEqual(before);
    expect(() => db.prepare("UPDATE memory_read_revision SET revision=revision-1").run()).toThrow("memory read revision must advance");
    expect(() => db.prepare("INSERT OR REPLACE INTO memory_read_revision VALUES(1,0)").run()).toThrow("memory read revision already exists");
    expect(() => db.prepare("DELETE FROM memory_read_revision").run()).toThrow("immutable memory read revision");
    expect((await value.runtime.reader.read("기억", budgets)).payload.state).toBe("available");
  });
  it("normalizes a failure starting the initial privacy transaction before any RPC", async () => {
    const value = await fixture();
    vi.spyOn(value.database.authority.db, "transaction").mockImplementation(() => {
      throw new Error("private database path / internal SQL");
    });
    await expect(value.runtime.reader.read("기억", budgets)).rejects.toMatchObject({
      code: "MEMORY_REFERENCE_PRIVACY_UNAVAILABLE", message: "MEMORY_REFERENCE_PRIVACY_UNAVAILABLE",
    });
    expect(value.transport.calls).toHaveLength(0);
  });
  it("keeps provider observation time distinct from later local preparation", async () => {
    const value = await fixture(); let clock = REFERENCE_NOW;
    const runtime = createProductionMemoryReference(value.database.authority, { ...value.options, clock: () => clock });
    const result = await runtime.reader.read("기억", budgets, async () => {
      clock = new Date(REFERENCE_NOW.getTime() + 1000);
    });
    expect(result.provider_status_received_at).toBe(REFERENCE_NOW.toISOString());
    expect(result.payload.prepared_at).toBe(clock.toISOString());
  });
  it("rechecks delegation expiry after transport cleanup", async () => {
    const value = await fixture(new Date(REFERENCE_NOW.getTime() + 2000).toISOString());
    let clock = REFERENCE_NOW;
    const runtime = createProductionMemoryReference(value.database.authority, { ...value.options, clock: () => clock });
    await expect(runtime.reader.read("기억", budgets, async () => {
      clock = new Date(REFERENCE_NOW.getTime() + 3000);
    })).rejects.toMatchObject({ code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" });
  });
  it("rejects a revoked signing key before any provider call", async () => {
    const value = await fixture();
    revokeMemoryEffectDelegationKey(value.database.authority, value.options.read_fence_config.signing_key_id);
    await expect(value.runtime.reader.read("기억", budgets)).rejects.toMatchObject({ code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" });
    expect(value.transport.calls).toHaveLength(0);
  });
  it("invalidates a read when its signing key is revoked during provider cleanup", async () => {
    const value = await fixture();
    await expect(value.runtime.reader.read("기억", budgets, async () => {
      revokeMemoryEffectDelegationKey(value.database.authority, value.options.read_fence_config.signing_key_id);
    })).rejects.toMatchObject({ code: "MEMORY_REFERENCE_PRIVACY_CHANGED" });
  });
  it.each([false, true])("rejects generation change even for an empty result (%s)", async empty => {
    const value = await fixture(); value.transport.empty = empty;
    value.transport.onCall = method => {
      if (method === "sb_generation_status" && value.transport.statuses === 2) {
        value.transport.statusOverrides = { generation_id: `sbgen:v1:${"9".repeat(64)}` };
      }
    };
    await expect(value.runtime.reader.read("기억", budgets)).rejects.toMatchObject({ code: "MEMORY_REFERENCE_GENERATION_CHANGED" });
  });
  it("does not keep a local transaction open over an RPC", async () => {
    const value = await fixture();
    value.transport.onCall = () => { expect(value.database.authority.db.inTransaction).toBe(false); };
    await value.runtime.reader.read("기억", budgets);
  });
  it("checks expiry after the last provider round trip", async () => {
    const value = await fixture(); let clock = REFERENCE_NOW;
    const runtime = createProductionMemoryReference(value.database.authority, { ...value.options, clock: () => clock });
    value.transport.onCall = method => {
      if (method === "sb_generation_status" && value.transport.statuses === 2) clock = new Date(REFERENCE_RECORD.valid_until);
    };
    const result = await runtime.reader.read("기억", budgets);
    expect(result.payload.records).toHaveLength(0);
    expect(result.payload.omissions.stale).toBe(1);
  });
  it("rejects bad queries and impossible envelopes before any RPC", async () => {
    const value = await fixture();
    await expect(value.runtime.reader.read("bad\0query", budgets)).rejects.toThrow("MEMORY_REFERENCE_INPUT_INVALID");
    await expect(value.runtime.reader.read("기억", { ...budgets, max_bytes: 1 })).rejects.toThrow("MEMORY_REFERENCE_BUDGET_IMPOSSIBLE");
    expect(value.transport.calls).toHaveLength(0);
  });
  it("returns a CLI envelope bounded including version, metadata and newline", async () => {
    const value = await fixture();
    const result = await execute(["memory", "context", "기억", "--db", value.database.path,
      "--limit", "1", "--max_bytes", "4000"], { clock: () => REFERENCE_NOW, memoryReferenceOptions: value.options });
    const context = result["context"] as { records: unknown[] };
    expect(context.records).toHaveLength(1);
    expect(Buffer.byteLength(`${JSON.stringify({ version: 1, ...result })}\n`)).toBeLessThanOrEqual(4000);
    expect(result["context_bytes"]).toBe(Buffer.byteLength(canonicalize(context)));
    expect(value.transport.calls.some(call => call.method === "sb_write_request")).toBe(false);
  });
  it("closes an internally owned provider exactly once across read cleanup and finally", async () => {
    const value = await fixture();
    const factory = vi.spyOn(transportFactory, "createSecondBrainTransport").mockReturnValue(value.transport);
    let closed = 0;
    vi.spyOn(value.transport, "close").mockImplementation(async () => {
      if (++closed > 1) throw new Error("double close");
    });
    const result = await execute(["memory", "context", "기억", "--db", value.database.path], {
      clock: () => REFERENCE_NOW, memoryReferenceOptions: { ...value.options, transport: undefined },
    });
    expect(result["ok"]).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(closed).toBe(1);
  });
  it.each([
    ["기억", "MEMORY_REFERENCE_PROVIDER_UNAVAILABLE"],
    ["bad\0query", "MEMORY_REFERENCE_INPUT_INVALID"],
  ])("preserves normalized errors when owned cleanup rejects (%s)", async (query, code) => {
    const value = await fixture();
    vi.spyOn(transportFactory, "createSecondBrainTransport").mockReturnValue(value.transport);
    const close = vi.spyOn(value.transport, "close").mockRejectedValue(new Error("private transport details"));
    await expect(execute(["memory", "context", query, "--db", value.database.path], {
      clock: () => REFERENCE_NOW, memoryReferenceOptions: { ...value.options, transport: undefined },
    })).rejects.toMatchObject({ code, message: code });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("never generates a missing key and rejects symlink, hardlink, public-mode and wrong-size keys", async () => {
    const value = await fixture(); const key = join(value.database.root, "memory-projection.key");
    expect(() => readMemoryReferenceProjectionKey(key)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
    expect(existsSync(key)).toBe(false);
    writeFileSync(key, Buffer.alloc(32, 7), { mode: 0o600 });
    expect(readMemoryReferenceProjectionKey(key)).toEqual(Buffer.alloc(32, 7));
    chmodSync(key, 0o644);
    expect(() => readMemoryReferenceProjectionKey(key)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
    chmodSync(key, 0o600);
    symlinkSync(key, `${key}.symlink`);
    expect(() => readMemoryReferenceProjectionKey(`${key}.symlink`)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
    writeFileSync(`${key}.short`, Buffer.alloc(31), { mode: 0o600 });
    expect(() => readMemoryReferenceProjectionKey(`${key}.short`)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
    linkSync(key, `${key}.hardlink`);
    expect(() => readMemoryReferenceProjectionKey(key)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
  });
  it.each([false, true])("normalizes projection key descriptor cleanup failure (invalid=%s)", async invalid => {
    const value = await fixture(); const path = join(value.database.root, "memory-projection.key");
    writeFileSync(path, Buffer.alloc(invalid ? 31 : 32), { mode: 0o600 });
    const close = filesystem.closeSync;
    vi.spyOn(filesystem, "closeSync").mockImplementation(fd => { close(fd); throw new Error("private descriptor details"); });
    expect(() => readMemoryReferenceProjectionKey(path)).toThrow("MEMORY_REFERENCE_KEY_UNAVAILABLE");
  });
  it.each([false, true])("normalizes signing key descriptor cleanup failure (invalid=%s)", async invalid => {
    const value = await fixture();
    if (invalid) writeFileSync(value.options.read_fence_config.private_key_path, "invalid key");
    const close = filesystem.closeSync;
    vi.spyOn(filesystem, "closeSync").mockImplementation(fd => { close(fd); throw new Error("private descriptor details"); });
    expect(() => createProductionMemoryReadFence(value.database.authority, value.options.read_fence_config))
      .toThrow("MEMORY_READ_FENCE_CONFIG_INVALID");
  });
  it("preserves the existing membership HMAC domain and pins mutable caller keys", () => {
    const key = Buffer.alloc(32, 7); const member = createMemoryMembership(key);
    const tokens = new MemoryTokenCache(key, () => REFERENCE_NOW);
    const expected = tokens.membership("record", "record\0digest");
    expect(expected).toBe("hmac-sha256:881a229958d80eeeddffb4a3c2a7e6e64a4752a8a5f3f3e34a1f8622b71741fd");
    expect(member("record", "record\0digest")).toBe(expected);
    const revision = tokens.revision("record", "session", "record\0digest");
    key.fill(0);
    expect(member("record", "record\0digest")).toBe(expected);
    expect(tokens.membership("record", "record\0digest")).toBe(expected);
    expect(tokens.revision("record", "session", "record\0digest")).toBe(revision);
  });
});
