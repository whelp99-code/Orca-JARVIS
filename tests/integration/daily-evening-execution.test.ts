import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { initialized } from "../helpers.js";
import { createStoredNativeEveningDailyLoop } from "../../src/daily-loop-evening-execution.js";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import { NativeEveningStore } from "../../src/evening-native-store.js";
import { signer, trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import type { DailyLoopOptions } from "../../src/daily-loop-types.js";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { SECOND_SOURCE_TARGET } from "../fixtures/morning-publication.js";
import { kstLocalDate } from "../../src/daily-loop-time.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const at = new Date("2026-08-30T12:30:00.000Z");
const source = { repository_identities: [], max_records: 10, max_bytes: 1048576 };
const options = (clock = () => at): DailyLoopOptions => ({ time_zone: "Asia/Seoul", owner_id: "evening-test",
  lease_ms: 30000, deadline_ms: 60000, recovery_window_ms: 60000, recovery_lookback_days: 2,
  refresh_freshness_ms: 60000, budgets: { max_items: 10, max_work: 10, max_bytes: 1048576 }, clock,
  event_source: { drain: () => { throw new Error("EVENING_MUST_NOT_DRAIN_EVENTS"); } },
  refresh_reader: { read: () => { throw new Error("EVENING_MUST_NOT_REFRESH"); } } });
async function empty() {
  const db = await initialized();
  cleanups.push(() => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); });
  return db;
}

it("schedules an empty signed report once across a fresh scheduler instance", async () => {
  const db = await empty(); let signed = 0; const handle = signer(at.toISOString());
  const signing = { ...handle, sign: (bytes: Uint8Array) => { signed++; return handle.sign(bytes); } };
  const create = () => createStoredNativeEveningDailyLoop(db, options(), source, trustedCloseoutKey, signing);
  const result = await create().startup(); expect(result.completed_run_ids).toHaveLength(1);
  const artifact = new NativeEveningStore(db, trustedCloseoutKey, source, () => at).read(result.completed_run_ids[0]);
  expect(artifact.native_completion_count).toBe(0); expect(artifact.source_readiness).toBe("degraded");
  expect((await create().startup()).completed_run_ids).toEqual([]); expect(signed).toBe(1);
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM native_evening_publications").get()).toEqual({ n: 1 });
});

it.each(["signer", "lease", "budget"] as const)("does not publish after %s failure", async mode => {
  const db = await empty(); let now = at; const config = options(() => now); const handle = signer(at.toISOString());
  const loop = createStoredNativeEveningDailyLoop(db,
    mode === "budget" ? { ...config, budgets: { ...config.budgets, max_bytes: 1 } } : config,
    source, trustedCloseoutKey, { ...handle, sign: bytes => {
      if (mode === "signer") throw new Error("SIGNING_FAILED");
      if (mode === "lease") now = new Date(at.getTime() + 30001);
      return handle.sign(bytes);
    } });
  if (mode === "budget") expect((await loop.startup()).completed_run_ids).toEqual([]);
  else await expect(loop.startup()).rejects.toThrow();
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM native_evening_publications").get()).toEqual({ n: 0 });
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM daily_loop_steps WHERE state='completed'").get()).toEqual({ n: 0 });
  const row = db.db.prepare(`SELECT state,failure_code,lease_owner FROM daily_loop_runs WHERE loop_date=?`)
    .get(kstLocalDate(at));
  // A refusal under a lease the cycle still holds fails the run and releases the lease, so the next
  // cycle can reach it. An expired lease is the one case the holder cannot terminate: that run stays
  // claimed until the lease runs out, which is exactly what it is for.
  expect(row).toEqual(mode === "budget" ? { state: "failed", failure_code: "BUDGET_BYTES_EXHAUSTED", lease_owner: null }
    : mode === "signer" ? { state: "failed", failure_code: "EXECUTION_FAILED", lease_owner: null }
    : { state: "claimed", failure_code: null, lease_owner: "evening-test" });
});

it("publishes a populated report only after recorded source provenance is available", async () => {
  const f = await taskPublicationFixture(); cleanups.push(f.cleanup);
  const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
  await settleTaskExecution({ ...input, publication_id: publication.publication_id });
  const config = { ...source, repository_identities: [f.plan.publication.repository_identity] };
  const store = new DailyLoopStore(f.db); const date = kstLocalDate(f.now);
  const id = store.prepare({ due: { kind: "due", local_date: date, phase: "evening", scheduled_at: f.now.toISOString() },
    created_at: f.now, deadline_at: new Date(f.now.getTime() + 60000), steps: [{ key: "evening_summary", sequence: 1 }] });
  const loop = createStoredNativeEveningDailyLoop(f.db, options(() => f.now), config, trustedCloseoutKey, signer(f.now.toISOString()));
  const claim = loop.claim(id);
  expect(() => loop.finish({ ...claim, fence: claim.fence + 1 })).toThrow("DAILY_LOOP_STALE_LEASE");
  expect(() => loop.finish(claim)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  new MemoryProjectionAuthority(f.db).bind({ kind: "control_payload", id: "execute", component_id: "execute" },
    [{ target_digest: SECOND_SOURCE_TARGET, source_identity_digest: `sha256:${"b".repeat(64)}` }], f.now);
  expect(loop.finish(claim)).toBe(true);
  expect(new NativeEveningStore(f.db, trustedCloseoutKey, config, () => f.now).read(id).native_completion_count).toBe(1);
});

it("rejects a morning claim before invoking the signer", async () => {
  const db = await empty(); const store = new DailyLoopStore(db); let signed = 0;
  const id = store.prepare({ due: { kind: "due", local_date: kstLocalDate(at), phase: "morning", scheduled_at: at.toISOString() },
    created_at: at, deadline_at: new Date(at.getTime() + 60000), steps: [{ key: "refresh_context", sequence: 1 }] });
  const handle = signer(at.toISOString());
  const loop = createStoredNativeEveningDailyLoop(db, options(), source, trustedCloseoutKey,
    { ...handle, sign: bytes => { signed++; return handle.sign(bytes); } });
  const claim = loop.claim(id);
  expect(() => loop.finish(claim)).toThrow("DAILY_LOOP_HANDLER_UNAVAILABLE");
  expect(signed).toBe(0);
  expect(store.steps(id)[0]?.state).toBe("pending");
});

it.each(["expired", "run", "step"] as const)("rejects %s authority before signing", async mode => {
  const db = await empty(); let now = at; let signed = 0; const handle = signer(at.toISOString());
  const loop = createStoredNativeEveningDailyLoop(db, options(() => now), source, trustedCloseoutKey,
    { ...handle, sign: bytes => { signed++; return handle.sign(bytes); } });
  const prepared = loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("scheduled run required");
  const claim = loop.claim(prepared.run_id); const store = new DailyLoopStore(db);
  if (mode === "expired") now = new Date(at.getTime() + 30001);
  else {
    const id = mode === "run" ? prepared.run_id : store.steps(prepared.run_id)[0]!.step_id;
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: mode === "run" ? "daily_run" : "daily_step", id, component_id: id }, at);
  }
  expect(() => loop.finish(claim)).toThrow(); expect(signed).toBe(0);
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM native_evening_publications").get()).toEqual({ n: 0 });
});

it("runNext atomically finishes the only step and returns no further work", async () => {
  const db = await empty();
  const loop = createStoredNativeEveningDailyLoop(db, options(), source, trustedCloseoutKey, signer(at.toISOString()));
  const prepared = loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("scheduled run required");
  expect(loop.runNext(loop.claim(prepared.run_id))).toBe(false);
  expect(new NativeEveningStore(db, trustedCloseoutKey, source, () => at).read(prepared.run_id).native_completion_count).toBe(0);
});
