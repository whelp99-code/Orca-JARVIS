import { afterEach, expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { MemoryReferenceProvider, REFERENCE_NOW } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
const budgets = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const session = { client_id: "native-fixture", session_id: "session-1", epoch_id: "epoch-1" };
async function fixture() {
  const db = await memoryDatabase(); databases.push(db);
  const provider = new MemoryReferenceProvider(); const { config } = memoryReadFenceFixture(db);
  const options = { transport: provider, read_fence_config: config, projection_key: Buffer.alloc(32, 7), clock: () => REFERENCE_NOW };
  const runtime = createProductionMemoryReference(db.authority, options);
  return { db, provider, options, runtime, read: () => runtime.reader.read("기억", budgets) };
}
function states(db: AuthorityDb): string[] {
  return (db.db.prepare("SELECT state FROM personal_context_reference_attempts ORDER BY created_at,attempt_id").all() as {state:string}[]).map(row => row.state);
}
it("persists callback completion and deduplicates a fresh read through a second DB connection", async () => {
  const value = await fixture();
  const original = await value.read();
  expect(await value.runtime.reader.submitInSession(original, async () => "first", session)).toBe("first");
  const connection = new AuthorityDb(value.db.path);
  try {
    const other = createProductionMemoryReference(connection, value.options);
    const current = await other.reader.read("기억", budgets);
    const send = vi.fn(async () => "duplicate");
    await expect(other.reader.submitInSession(current, send, session)).rejects.toThrow("MEMORY_REFERENCE_ALREADY_SUBMITTED");
    expect(send).not.toHaveBeenCalled(); expect(states(connection)).toEqual(["callback_completed"]);
    const dump = JSON.stringify(connection.db.prepare("SELECT * FROM personal_context_reference_attempts").all());
    for (const secret of [original.serialized, original.payload.records[0]!.text, "session-1", "epoch-1",
      original.payload.records[0]!.record.record_id]) expect(dump).not.toContain(secret);
  } finally { connection.close(); }
});
it("blocks another object while dispatch is pending and preserves uncertainty on failure", async () => {
  const value = await fixture(); const first = await value.read(); const second = await value.read();
  const entered = Promise.withResolvers<void>(); const done = Promise.withResolvers<string>();
  const running = value.runtime.reader.submitInSession(first, () => { entered.resolve(); return done.promise; }, session);
  const caught = expect(running).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_UNCONFIRMED");
  await entered.promise;
  expect(states(value.db.authority)).toEqual(["dispatching"]);
  const send = vi.fn(async () => "must not send");
  await expect(value.runtime.reader.submitInSession(second, send, session)).rejects.toThrow("MEMORY_REFERENCE_DELIVERY_UNCONFIRMED");
  done.reject(new Error("uncertain network")); await caught;
  expect(states(value.db.authority)).toEqual(["unconfirmed"]);
  await expect(value.runtime.reader.submitInSession(await value.read(), send, {...session, epoch_id:"epoch-2"}))
    .rejects.toThrow("MEMORY_REFERENCE_DELIVERY_UNCONFIRMED");
  expect(send).not.toHaveBeenCalled();
});
it("allows an adapter-observed new epoch after a completed attempt", async () => {
  const value = await fixture();
  await value.runtime.reader.submitInSession(await value.read(), async () => "first", session);
  await value.runtime.reader.submitInSession(await value.read(), async () => "compacted", {...session, epoch_id:"epoch-2"});
  expect(states(value.db.authority)).toEqual(["callback_completed","callback_completed"]);
});
it("invalidates the session atomically with privacy changes and cannot revive it with a new epoch", async () => {
  const value = await fixture();
  await expect(value.runtime.reader.submitInSession(await value.read(), async () => {
    value.db.authority.db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
    expect(states(value.db.authority)).toEqual(["invalidated"]);
    return "withhold";
  },session)).rejects.toThrow("MEMORY_REFERENCE_PRIVACY_CHANGED");
  const send = vi.fn(async () => "must not send");
  await expect(value.runtime.reader.submitInSession(await value.read(),send,{...session,epoch_id:"epoch-2"}))
    .rejects.toThrow("MEMORY_REFERENCE_SESSION_INVALIDATED");
  expect(send).not.toHaveBeenCalled();
  await value.runtime.reader.submitInSession(await value.read(), async () => "fresh session", {...session,session_id:"session-2"});
  expect(states(value.db.authority).sort()).toEqual(["callback_completed","invalidated"]);
});
it("rolls back invalidation with an aborted privacy transaction", async () => {
  const value = await fixture(); await value.runtime.reader.submitInSession(await value.read(),async () => "ok",session);
  expect(() => value.db.authority.db.transaction(() => {
    value.db.authority.db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect(states(value.db.authority)).toEqual(["callback_completed"]);
});
it("rejects key replacement before a duplicate or new session dispatch", async () => {
  const value = await fixture();
  await value.runtime.reader.submitInSession(await value.read(),async () => "ok",session);
  const changed = createProductionMemoryReference(value.db.authority, {...value.options,projection_key:Buffer.alloc(32,8)});
  const send = vi.fn(async () => "must not send");
  for (const candidate of [session,{...session,session_id:"session-2"}]) {
    await expect(changed.reader.submitInSession(await changed.reader.read("기억",budgets),send,candidate))
      .rejects.toThrow("MEMORY_REFERENCE_KEY_CHANGED");
  }
  expect(send).not.toHaveBeenCalled(); expect(states(value.db.authority)).toEqual(["callback_completed"]);
});
it("deduplicates empty results independently of preparation time", async () => {
  const value = await fixture(); value.provider.empty = true;
  let now = REFERENCE_NOW;
  const runtime = createProductionMemoryReference(value.db.authority, {...value.options,clock:()=>now});
  await runtime.reader.submitInSession(await runtime.reader.read("기억",budgets),async () => "empty",session);
  now = new Date(REFERENCE_NOW.getTime()+1000);
  const send = vi.fn(async () => "duplicate");
  await expect(runtime.reader.submitInSession(await runtime.reader.read("기억",budgets),send,session))
    .rejects.toThrow("MEMORY_REFERENCE_ALREADY_SUBMITTED");
  expect(send).not.toHaveBeenCalled();
});
it("preserves invalidated session markers and key binding through fresh-file reconstruction", async () => {
  const value = await fixture();
  await value.runtime.reader.submitInSession(await value.read(),async () => "ok",session);
  value.db.authority.db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
  const { buildFreshAuthority } = await import("../../src/memory-authority-fresh-builder.js");
  const path = `${value.db.root}/fresh.sqlite`;
  const result = await buildFreshAuthority(value.db.authority,path);
  expect(result.integrity_check).toBe("ok");
  const fresh = new AuthorityDb(path);
  try {
    const runtime = createProductionMemoryReference(fresh,value.options);
    const send = vi.fn(async () => "must not send");
    await expect(runtime.reader.submitInSession(await runtime.reader.read("기억",budgets),send,{...session,epoch_id:"epoch-2"}))
      .rejects.toThrow("MEMORY_REFERENCE_SESSION_INVALIDATED");
    expect(send).not.toHaveBeenCalled(); expect(states(fresh)).toEqual(["invalidated"]);
    expect(fresh.db.prepare("SELECT * FROM personal_context_reference_identity").all())
      .toEqual(value.db.authority.db.prepare("SELECT * FROM personal_context_reference_identity").all());
  } finally { fresh.close(); }
});
it("rejects deletion, replacement and revival of durable markers", async () => {
  const value = await fixture(); await value.runtime.reader.submitInSession(await value.read(),async () => "ok",session);
  const db = value.db.authority.db;
  for (const table of ["identity","sessions","attempts"]) {
    expect(() => db.exec(`DELETE FROM personal_context_reference_${table}`)).toThrow(/immutable/);
    expect(() => db.exec(`INSERT OR REPLACE INTO personal_context_reference_${table} SELECT * FROM personal_context_reference_${table}`))
      .toThrow(/immutable|already exists/);
  }
  expect(() => db.exec("UPDATE personal_context_reference_attempts SET state='dispatching'")).toThrow(/invalid reference attempt transition/);
  db.exec("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1");
  expect(() => db.exec("UPDATE personal_context_reference_sessions SET state='active',binding_key='revived'"))
    .toThrow(/immutable/);
});
it("keeps the outward uncertainty error when deletion wins during a failed callback", async () => {
  const value = await fixture();
  await expect(value.runtime.reader.submitInSession(await value.read(),async () => {
    value.db.authority.db.exec("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1");
    throw new Error("network lost after deletion");
  },session)).rejects.toThrow("MEMORY_REFERENCE_SUBMISSION_UNCONFIRMED");
  expect(states(value.db.authority)).toEqual(["invalidated"]);
});
it("rejects journal status and mutations from a different key", async () => {
  const value = await fixture(); await value.runtime.reader.submitInSession(await value.read(),async () => "ok",session);
  const { MemoryReferenceDeliveries } = await import("../../src/memory-reference-deliveries.js");
  const { createMemoryMembership } = await import("../../src/memory-membership.js");
  const journal = new MemoryReferenceDeliveries(value.db.authority,createMemoryMembership(Buffer.alloc(32,8)));
  const id = (value.db.authority.db.prepare("SELECT attempt_id FROM personal_context_reference_attempts").get() as {attempt_id:string}).attempt_id;
  expect(() => journal.status(id)).toThrow("MEMORY_REFERENCE_KEY_CHANGED");
  expect(() => journal.finish(id,"unconfirmed",REFERENCE_NOW)).toThrow("MEMORY_REFERENCE_KEY_CHANGED");
  expect(() => journal.invalidate(id,REFERENCE_NOW)).toThrow("MEMORY_REFERENCE_KEY_CHANGED");
  expect(states(value.db.authority)).toEqual(["callback_completed"]);
});
it("requires an explicit session on the durable API", async () => {
  const value = await fixture(); const send = vi.fn(async () => "never");
  // @ts-expect-error runtime callers cannot silently downgrade to a non-durable submission
  await expect(value.runtime.reader.submitInSession(await value.read(),send)).rejects.toThrow("MEMORY_REFERENCE_SESSION_INVALID");
  expect(send).not.toHaveBeenCalled();
});
it("upgrades an exact prior-070 database without rewriting prior data or migrations", async () => {
  const { mkdtempSync, readdirSync, mkdirSync, copyFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(),"jarvis-reference-upgrade-"));
  const migrations = join(root,"migrations"); mkdirSync(migrations);
  const source = join(process.cwd(),"migrations");
  for (const file of readdirSync(source)) if (file.endsWith(".sql") && file < "071_") copyFileSync(join(source,file),join(migrations,file));
  const db = new AuthorityDb(join(root,"authority.sqlite"),migrations);
  try {
    await db.migrate();
    db.db.exec("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1");
    const oldJournal = db.db.prepare("SELECT * FROM schema_migrations ORDER BY id").all();
    const oldPrivacy = db.db.prepare("SELECT * FROM memory_surface_authority").all();
    const file = "071_memory_reference_deliveries.sql"; copyFileSync(join(source,file),join(migrations,file));
    await db.migrate(); await db.migrate();
    expect(db.db.prepare("SELECT * FROM schema_migrations WHERE id<'071_' ORDER BY id").all()).toEqual(oldJournal);
    expect(db.db.prepare("SELECT * FROM memory_surface_authority").all()).toEqual(oldPrivacy);
    expect(db.db.prepare("SELECT * FROM personal_context_reference_sessions").all()).toEqual([]);
  } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
});
it("rejects non-finite mutation clocks and backward SQL updates", async () => {
  const value = await fixture(); await value.runtime.reader.submitInSession(await value.read(),async()=>"ok",session);
  const { MemoryReferenceDeliveries } = await import("../../src/memory-reference-deliveries.js");
  const { createMemoryMembership } = await import("../../src/memory-membership.js");
  const journal = new MemoryReferenceDeliveries(value.db.authority,createMemoryMembership(Buffer.alloc(32,7)));
  const id = (value.db.authority.db.prepare("SELECT attempt_id FROM personal_context_reference_attempts").get() as {attempt_id:string}).attempt_id;
  expect(() => journal.finish(id,"unconfirmed",new Date(NaN))).toThrow("MEMORY_REFERENCE_SESSION_INVALID");
  expect(() => journal.invalidate(id,new Date(NaN))).toThrow("MEMORY_REFERENCE_SESSION_INVALID");
  expect(() => value.db.authority.db.exec("UPDATE personal_context_reference_attempts SET updated_at='2000-01-01T00:00:00.000Z'"))
    .toThrow(/invalid reference attempt transition|CHECK/);
});
