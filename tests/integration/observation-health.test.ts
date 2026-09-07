import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, JarvisError } from "../../src/db.js";
import { LiveSupervisor, type LiveBinding } from "../../src/live-supervisor.js";
import { observePersistedBinding } from "../../src/persisted-orca-observer.js";
import { beginObservation, finishObservation } from "../../src/observation-health-store.js";
import { readObservationHealth } from "../../src/runtime-health.js";
import { cycleLiveObservations } from "../../src/live-supervisor-observations.js";
import type { OrcaRunner } from "../../src/orca.js";
import { tempDb } from "../helpers.js";

const databases: AuthorityDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.db.open) db.close(); });
async function setup() {
  const path = tempDb(); const db = new AuthorityDb(path); databases.push(db); await db.migrate();
  const supervisor = new LiveSupervisor(db);
  const binding = supervisor.register({ worktree: process.cwd(), provider: "codex", terminal_id: "term",
    session_id: "session", incarnation_id: "inc", pty_id: "pty", worktree_id: "wt" });
  return { db, supervisor, binding, path };
}
function healthy(binding: LiveBinding, cursor = "fresh"): OrcaRunner {
  return async args => JSON.stringify({ ok: true, result: args[1] === "list" ? { terminals: [{
    handle: binding.terminal_id, incarnationId: binding.incarnation_id, ptyId: binding.pty_id, worktreeId: binding.worktree_id,
    worktreePath: binding.canonical_path, connected: true, writable: true, title: null, preview: null, lastOutputAt: null,
  }] } : { terminal: { handle: binding.terminal_id, status: "running", tail: [], returnedLineCount: 0,
    truncated: false, limited: false, oldestCursor: null, nextCursor: cursor, latestCursor: cursor } } });
}
const outage: OrcaRunner = async () => { throw new JarvisError("ORCA_CLI_TIMEOUT"); };
const base = Date.parse("2026-09-08T09:00:00.000Z");
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

describe("durable observation health", () => {
  it("refuses a new attempt from a stale cursor snapshot before invoking Orca", async () => {
    const { db, supervisor, binding } = await setup(); const clock = () => new Date(base);
    const cycle = await cycleLiveObservations(db, current => observePersistedBinding(db, current, healthy(current, "C2"), clock));
    supervisor.acknowledgeReport(cycle.report!.report_id);
    let reads = 0;
    await expect(observePersistedBinding(db, binding, async args => { reads++; return healthy(binding, "C1")(args); }, clock))
      .rejects.toMatchObject({ code: "LIVE_OBSERVATION_CURSOR_STALE" });
    expect(reads).toBe(0);
    expect(db.db.prepare("SELECT next_cursor FROM live_supervisor_cursors WHERE terminal_id=?").get(binding.terminal_id))
      .toEqual({ next_cursor: "C2" });
  });
  it("keeps skipped reads and timestamps unchanged across restart, then grows and resets bounded backoff", async () => {
    const { db, binding, path } = await setup(); let now = base;
    await observePersistedBinding(db, binding, healthy(binding), () => new Date(now));
    const success = new Date(now).toISOString(); now += 1000;
    await observePersistedBinding(db, binding, outage, () => new Date(now));
    const saved = readObservationHealth(db, new Date(now)).bindings[0]!;
    expect(saved).toMatchObject({ state: "unavailable", consecutive_failures: 1, last_success_at: success,
      next_attempt_at: new Date(now + 10_000).toISOString() });
    db.close(); const reopened = new AuthorityDb(path); databases.push(reopened);
    const before = reopened.db.prepare("SELECT total_changes() AS n").get(); let reads = 0;
    await expect(observePersistedBinding(reopened, binding, async () => { reads++; return "{}"; }, () => new Date(now + 9999)))
      .resolves.toEqual([]);
    expect(reads).toBe(0); expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(readObservationHealth(reopened, new Date(now + 9999)).bindings[0]).toEqual(saved);
    for (const delay of [20_000, 40_000, 60_000, 60_000]) {
      now = Date.parse(readObservationHealth(reopened, new Date(now)).bindings[0]!.next_attempt_at!);
      await observePersistedBinding(reopened, binding, outage, () => new Date(now));
      const row = readObservationHealth(reopened, new Date(now)).bindings[0]!;
      expect(row.next_attempt_at).toBe(new Date(now + delay).toISOString()); expect(row.last_success_at).toBe(success);
    }
    now = Date.parse(readObservationHealth(reopened, new Date(now)).bindings[0]!.next_attempt_at!);
    await observePersistedBinding(reopened, binding, healthy(binding), () => new Date(now));
    expect(readObservationHealth(reopened, new Date(now)).bindings[0]).toMatchObject({ state: "healthy", consecutive_failures: 0,
      next_attempt_at: null, error_code: null, last_success_at: new Date(now).toISOString() });
    await observePersistedBinding(reopened, binding, async () => JSON.stringify({ ok: true, result: { terminals: [] } }),
      () => new Date(now + 1000));
    expect(readObservationHealth(reopened, new Date(now + 1000)).bindings[0])
      .toMatchObject({ state: "unknown", last_success_at: new Date(now).toISOString() });
  });

  it("uses completion time, expires abandoned attempts and refuses stale completions", async () => {
    const { db, binding } = await setup(); let now = base;
    const token = beginObservation(db, binding, new Date(now))!;
    expect(beginObservation(db, binding, new Date(now + 14_999))).toBeNull();
    now += 15_000; const replacement = beginObservation(db, binding, new Date(now))!;
    expect(replacement).not.toBe(token);
    expect(() => finishObservation(db, binding, token, new Date(now), "healthy", null)).toThrow("LIVE_OBSERVATION_ATTEMPT_STALE");
    finishObservation(db, binding, replacement, new Date(now), "healthy", null);
    await observePersistedBinding(db, binding, async args => { now += 100; return healthy(binding)(args); }, () => new Date(now));
    const row = readObservationHealth(db, new Date(now)).bindings[0]!;
    expect(row.last_success_at).toBe(new Date(base + 15_200).toISOString());
    expect(row.last_attempt_at).toBe(new Date(base + 15_000).toISOString());
    expect(() => beginObservation(db, binding, new Date(now - 1))).toThrow("LIVE_OBSERVATION_CLOCK_REGRESSED");
    const expired = beginObservation(db, binding, new Date(now))!;
    expect(() => finishObservation(db, binding, expired, new Date(now + 15_000), "healthy", null))
      .toThrow("LIVE_OBSERVATION_ATTEMPT_EXPIRED");
    expect(readObservationHealth(db, new Date(now)).bindings[0]!.last_success_at).toBe(row.last_success_at);
  });

  it("keeps a fatal error blocking while another attempt is in flight", async () => {
    const { db, binding } = await setup(); const wait = deferred<string>(); const started = deferred<void>();
    const clock = () => new Date(base);
    await expect(observePersistedBinding(db, binding, async () => { throw new JarvisError("ORCA_PERMISSION_DENIED"); }, clock))
      .rejects.toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
    const recovering = observePersistedBinding(db, binding, async args => {
      if (args[1] === "list") { started.resolve(); return wait.promise; } return healthy(binding)(args);
    }, clock);
    await started.promise;
    await expect(observePersistedBinding(db, binding, healthy(binding), clock)).rejects.toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
    wait.resolve(await healthy(binding)(["terminal", "list"])); await recovering;
    expect(readObservationHealth(db, clock()).bindings[0]).toMatchObject({ state: "healthy", error_code: null });
  });

  it("does not let an old incarnation delay or overwrite a newly authorized binding", async () => {
    const { db, binding } = await setup(); const old = beginObservation(db, binding, new Date(base))!;
    // Simulate an operator-managed replacement; registration still rejects automatic rebinding.
    const next = { ...binding, incarnation_id: "inc-new", session_id: "session-new" };
    expect(() => new LiveSupervisor(db).register({ ...next, worktree: next.canonical_path })).toThrow("LIVE_BINDING_REBIND_REJECTED");
    db.db.prepare("UPDATE live_supervisor_bindings SET incarnation_id=?,session_id=? WHERE terminal_id=?")
      .run(next.incarnation_id, next.session_id, next.terminal_id);
    await observePersistedBinding(db, next, healthy(next), () => new Date(base + 1));
    expect(() => finishObservation(db, binding, old, new Date(base + 2), "healthy", null)).toThrow("LIVE_OBSERVATION_BINDING_CHANGED");
    expect(readObservationHealth(db, new Date(base + 2)).bindings[0])
      .toMatchObject({ incarnation_id: "inc-new", state: "healthy", consecutive_failures: 0 });
  });

  it("rejects an old cycle at the final cursor transaction after a newer cycle finishes", async () => {
    const { db, supervisor, binding } = await setup();
    const second = supervisor.register({ worktree: process.cwd(), provider: "claude", terminal_id: "slow",
      session_id: "s2", incarnation_id: "i2", pty_id: "p2", worktree_id: "w2" });
    const release = deferred<void>(); const firstDone = deferred<void>();
    const old = cycleLiveObservations(db, async current => {
      if (current.terminal_id === second.terminal_id) await release.promise;
      const values = await observePersistedBinding(db, current, healthy(current, "old"), () => new Date(base));
      if (current.terminal_id === binding.terminal_id) firstDone.resolve();
      return values;
    }, new Date(base).toISOString());
    const oldResult = old.catch(error => error); await firstDone.promise;
    await cycleLiveObservations(db, current => current.terminal_id === binding.terminal_id
      ? observePersistedBinding(db, current, healthy(current, "new"), () => new Date(base + 1)) : [], new Date(base + 1).toISOString());
    release.resolve();
    expect(await oldResult).toMatchObject({ code: "LIVE_OBSERVATION_ATTEMPT_STALE" });
    expect(db.db.prepare("SELECT next_cursor FROM live_supervisor_cursors WHERE terminal_id=?").get(binding.terminal_id)).toEqual({ next_cursor: "new" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_reports").get()).toEqual({ n: 1 });
  });

  it("waits for all in-flight readers before propagating a fatal error", async () => {
    const { db, supervisor, binding } = await setup();
    supervisor.register({ worktree: process.cwd(), provider: "claude", terminal_id: "slow", session_id: "s2", incarnation_id: "i2" });
    const release = deferred<void>(); const started = deferred<void>(); let settled = false;
    const result = cycleLiveObservations(db, async current => {
      if (current.terminal_id === binding.terminal_id) throw new JarvisError("ORCA_PERMISSION_DENIED");
      started.resolve(); await release.promise; return [];
    }).then(() => { settled = true; }, error => { settled = true; return error; });
    await started.promise; expect(settled).toBe(false); release.resolve();
    expect(await result).toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
  });
});
