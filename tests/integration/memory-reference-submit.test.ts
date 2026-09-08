import { afterEach, expect, it, vi } from "vitest";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { MemoryReferenceProvider, REFERENCE_NOW, REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });
const budgets = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
async function fixture(empty = false) {
  const database = await memoryDatabase(); databases.push(database);
  const provider = new MemoryReferenceProvider(); provider.empty = empty;
  const { config } = memoryReadFenceFixture(database, "2099-01-01T00:00:00.000Z");
  let now = REFERENCE_NOW;
  const options = { transport: provider, read_fence_config: config, projection_key: Buffer.alloc(32, 7), clock: () => now };
  const runtime = createProductionMemoryReference(database.authority, options);
  const reference = await runtime.reader.read("기억", budgets);
  return { database, provider, config, options, runtime, reference, advance: (at: Date) => { now = at; } };
}

it.each([false, true])("submits exactly the counted payload and returns only after revalidation (empty=%s)", async empty => {
  const value = await fixture(empty);
  const send = vi.fn(async (serialized: string) => {
    expect(value.database.authority.db.inTransaction).toBe(false);
    expect(serialized).toBe(value.reference.serialized);
    expect(Buffer.byteLength(serialized)).toBe(value.reference.bytes);
    return "native callback result";
  });
  expect(await value.runtime.reader.submit(value.reference, send)).toBe("native callback result");
  expect(send).toHaveBeenCalledTimes(1);
  expect(value.provider.statuses).toBe(4);
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  expect(send).toHaveBeenCalledTimes(1);
});

it("rejects copied, foreign-reader and mutated references before callback invocation", async () => {
  const value = await fixture(); const send = vi.fn(async () => "unused");
  await expect(value.runtime.reader.submit({ ...value.reference }, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  const other = createProductionMemoryReference(value.database.authority, value.options);
  await expect(other.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  Object.assign(value.reference.payload.records[0]!, { text: "caller changed the source" });
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  expect(send).not.toHaveBeenCalled();
});

it("claims before provider I/O and prevents a second submission during the first callback", async () => {
  const value = await fixture();
  const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<string>();
  const send = vi.fn(() => { entered.resolve(); return finish.promise; });
  const first = value.runtime.reader.submit(value.reference, send);
  await entered.promise;
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  expect(send).toHaveBeenCalledTimes(1); finish.resolve("done");
  expect(await first).toBe("done");
});

it("expires no-data submissions even though the public payload has no record deadline", async () => {
  const value = await fixture(true); const send = vi.fn(async () => "unused");
  expect(value.reference.payload.fresh_until).toBeNull();
  value.advance(new Date("2026-10-01T00:00:00.000Z"));
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_EXPIRED");
  expect(send).not.toHaveBeenCalled();
});

it("expires a current result with every record omitted at the exact 60-second boundary", async () => {
  const value = await fixture(); const send = vi.fn(async () => "unused");
  const omitted = await value.runtime.reader.read("기억", { ...budgets, max_record_bytes: 1 });
  expect(omitted.payload.records).toHaveLength(0);
  expect(omitted.payload.omissions.record_budget).toBe(1);
  value.advance(new Date(REFERENCE_NOW.getTime() + 60_000));
  await expect(value.runtime.reader.submit(omitted, send)).rejects.toThrow("MEMORY_REFERENCE_EXPIRED");
  expect(send).not.toHaveBeenCalled();
});

it.each(["cycle", "getter"])("classifies caller %s mutation before entering an authority transaction", async kind => {
  const value = await fixture(); const send = vi.fn(async () => "unused");
  if (kind === "cycle") Object.assign(value.reference, { self: value.reference });
  else Object.defineProperty(value.reference, "payload", { get: () => {
    expect(value.database.authority.db.inTransaction).toBe(false);
    throw new Error("private caller exception");
  } });
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toMatchObject({
    code: "MEMORY_REFERENCE_SUBMISSION_INVALID", message: "MEMORY_REFERENCE_SUBMISSION_INVALID" });
  expect(send).not.toHaveBeenCalled();
});

it("normalizes an uncertain callback failure and never retries the same issued object", async () => {
  const value = await fixture(); const send = vi.fn(async () => { throw new Error("private model reply/path"); });
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toMatchObject({
    code: "MEMORY_REFERENCE_SUBMISSION_UNCONFIRMED", message: "MEMORY_REFERENCE_SUBMISSION_UNCONFIRMED" });
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
  expect(send).toHaveBeenCalledTimes(1);
});

for (const phase of ["before", "during"] as const) {
  for (const change of ["privacy", "generation", "expiry", "key"] as const) {
    it(`rejects ${change} ${phase} submission and withholds the callback result`, async () => {
      const value = await fixture();
      const mutate = () => {
        if (change === "privacy") value.database.authority.db.prepare(
          "UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
        if (change === "generation") value.provider.statusOverrides = { generation_id: `sbgen:v1:${"9".repeat(64)}` };
        if (change === "expiry") value.advance(new Date(value.reference.payload.fresh_until!));
        if (change === "key") revokeMemoryEffectDelegationKey(value.database.authority, value.config.signing_key_id);
      };
      if (phase === "before") mutate();
      const send = vi.fn(async () => { if (phase === "during") mutate(); return "must not escape"; });
      const code = { privacy: "MEMORY_REFERENCE_PRIVACY_CHANGED", generation: "MEMORY_REFERENCE_GENERATION_CHANGED",
        expiry: "MEMORY_REFERENCE_EXPIRED", key: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" }[change];
      await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow(code);
      expect(send).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
    });
  }
}

it("rejects privacy changes while final provider status is awaiting completion", async () => {
  const value = await fixture();
  value.provider.onCall = method => {
    if (method === "sb_generation_status" && value.provider.statuses === 4) value.database.authority.db.prepare(
      "UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
  };
  await expect(value.runtime.reader.submit(value.reference, async () => REFERENCE_RECORD.record_text))
    .rejects.toThrow("MEMORY_REFERENCE_PRIVACY_CHANGED");
});

it.each([3, 4])("normalizes provider outage at status %s and does not replay the attempt", async at => {
  const value = await fixture(); const send = vi.fn(async () => "result");
  value.provider.onCall = method => {
    if (method === "sb_generation_status" && value.provider.statuses === at) throw new Error("private transport message");
  };
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
  expect(send).toHaveBeenCalledTimes(at === 3 ? 0 : 1);
  await expect(value.runtime.reader.submit(value.reference, send)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_INVALID");
});
