import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { DailyControlLoop, DailyLoopStore, type DailyLoopConfig, type DailyLoopEvent, type RefreshCompletion } from "../../src/daily-loop.js";
import { tempDb } from "../helpers.js";

const config: DailyLoopConfig = {
  time_zone: "Asia/Seoul",
  owner_id: "linux:one",
  lease_ms: 60_000,
  deadline_ms: 10 * 60_000,
  recovery_window_ms: 2 * 60 * 60_000,
  refresh_freshness_ms: 30 * 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 },
};
const fresh: RefreshCompletion = {
  schema_version: 1,
  refresh_id: "refresh:1",
  state: "completed",
  completed_at: "2026-08-30T22:00:00.000Z",
  protocol_version: 1,
  capped: false,
};
const event = (event_id: string, critical = false): DailyLoopEvent => ({
  kind: "event",
  event_id,
  critical,
  items: 1,
  work: 1,
  bytes: 16,
});

async function fixture(now: string, owner = "linux:one", events: readonly DailyLoopEvent[] = []) {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  let clock = new Date(now);
  let pending = [...events];
  const loop = new DailyControlLoop(new DailyLoopStore(db), {
    ...config,
    owner_id: owner,
    clock: () => clock,
    event_source: {
      drain: () => {
        const drained = pending;
        pending = [];
        return drained;
      },
    },
    refresh_reader: { read: () => fresh },
  });
  return {
    db,
    loop,
    setClock: (value: string) => {
      clock = new Date(value);
    },
    push: (value: DailyLoopEvent) => {
      pending.push(value);
    },
  };
}

const count = (db: AuthorityDb, table: string): number => Number((db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("durable Daily Control Loop", () => {
  it("correlates morning, duplicate in-day event, and evening into three completed runs", async () => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");

    // When
    await f.loop.cycle();
    f.setClock("2026-08-31T03:00:00.000Z");
    f.push(event("evt:calendar:1"));
    f.push(event("evt:calendar:1"));
    await f.loop.cycle();
    f.setClock("2026-08-31T12:30:00.000Z");
    await f.loop.cycle();

    // Then
    expect(f.db.db.prepare("SELECT loop_date,state FROM daily_loop_runs ORDER BY created_at,run_id").all()).toEqual([
      { loop_date: "2026-08-31", state: "completed" },
      { loop_date: "2026-08-31", state: "completed" },
      { loop_date: "2026-08-31", state: "completed" },
    ]);
    expect(count(f.db, "daily_loop_steps")).toBe(4);
    expect(count(f.db, "daily_loop_checkpoints")).toBe(21);
    const correlations = f.db.db.prepare("SELECT correlation_id FROM daily_loop_runs").all() as Array<{ correlation_id: string }>;
    expect(correlations.every((row) => row.correlation_id.startsWith("daily:2026-08-31:"))).toBe(true);
    f.db.close();
  });

  it("reclaims only after expiry with fence n+1 and resumes completed steps", async () => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");
    const run = f.loop.prepare({ kind: "scheduled" });
    expect(run.kind).toBe("prepared");
    if (run.kind !== "prepared") throw new Error("fixture did not prepare");
    const first = f.loop.claim(run.run_id);
    f.loop.runNext(first);
    const completedBefore = count(f.db, "daily_loop_steps");
    const second = new DailyLoopStore(f.db);

    // When / Then
    expect(() =>
      second.claim({
        run_id: run.run_id,
        owner_id: "linux:two",
        at: new Date("2026-08-30T22:15:30.000Z"),
        lease_ms: 60_000,
      }),
    ).toThrow("DAILY_LOOP_LEASE_ACTIVE");
    const reclaimed = second.claim({
      run_id: run.run_id,
      owner_id: "linux:two",
      at: new Date("2026-08-30T22:16:00.000Z"),
      lease_ms: 60_000,
    });
    expect(reclaimed.fence).toBe(first.fence + 1);
    const resumed = new DailyControlLoop(second, {
      ...config,
      owner_id: "linux:two",
      clock: () => new Date("2026-08-30T22:16:00.000Z"),
      event_source: { drain: () => [] },
      refresh_reader: { read: () => fresh },
    });
    resumed.finish(reclaimed);
    expect(count(f.db, "daily_loop_steps")).toBe(completedBefore);
    expect(f.db.db.prepare("SELECT state,lease_fence FROM daily_loop_runs WHERE run_id=?").get(run.run_id)).toEqual({ state: "completed", lease_fence: 2 });
    f.db.close();
  });

  it("recovers a crash immediately after claim without replay and increments the fence", async () => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");
    const prepared = f.loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture did not prepare");
    const crashed = f.loop.claim(prepared.run_id);

    // When
    const at = new Date("2026-08-30T22:16:00.000Z");
    const store = new DailyLoopStore(f.db);
    const recovered = store.claim({ run_id: prepared.run_id, owner_id: "linux:recovery", at, lease_ms: 60_000 });
    const service = new DailyControlLoop(store, {
      ...config, owner_id: "linux:recovery", clock: () => at,
      event_source: { drain: () => [] }, refresh_reader: { read: () => fresh },
    });
    service.finish(recovered);

    // Then
    expect(recovered.fence).toBe(crashed.fence + 1);
    expect(f.db.db.prepare("SELECT DISTINCT lease_fence FROM daily_loop_checkpoints").all()).toEqual([{ lease_fence: 2 }]);
    f.db.close();
  });

  it("fails stale owner and fence writes and preserves an exact digest chain", async () => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");
    const prepared = f.loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture did not prepare");
    const oldClaim = f.loop.claim(prepared.run_id);
    f.setClock("2026-08-30T22:16:00.000Z");
    const current = new DailyLoopStore(f.db).claim({
      run_id: prepared.run_id,
      owner_id: "linux:two",
      at: new Date("2026-08-30T22:16:00.000Z"),
      lease_ms: 60_000,
    });

    // When / Then
    const staleStore = new DailyLoopStore(f.db);
    const reclaimedAt = new Date("2026-08-30T22:16:00.000Z");
    expect(() => staleStore.appendCheckpoint({
      claim: oldClaim, step_id: null, state: "running", detail: "stale", at: reclaimedAt,
    })).toThrow("DAILY_LOOP_STALE_LEASE");
    expect(() => staleStore.complete(oldClaim, reclaimedAt)).toThrow("DAILY_LOOP_STALE_LEASE");
    const service = new DailyControlLoop(new DailyLoopStore(f.db), {
      ...config,
      owner_id: "linux:two",
      clock: () => new Date("2026-08-30T22:16:00.000Z"),
      event_source: { drain: () => [] },
      refresh_reader: { read: () => fresh },
    });
    service.finish(current);
    const chain = f.db.db
      .prepare("SELECT sequence,previous_digest,checkpoint_digest FROM daily_loop_checkpoints WHERE run_id=? ORDER BY sequence")
      .all(prepared.run_id) as Array<{
      sequence: number;
      previous_digest: string | null;
      checkpoint_digest: string;
    }>;
    expect(chain[0]?.previous_digest).toBeNull();
    expect(chain.every((row, index) => row.sequence === index + 1 && (index === 0 || row.previous_digest === chain[index - 1]?.checkpoint_digest))).toBe(true);
    f.db.close();
  });

  it("reconciles missed schedules once and records outside-window omissions", async () => {
    // Given
    const inside = await fixture("2026-08-30T23:00:00.000Z");
    const outside = await fixture("2026-08-31T02:00:00.000Z");

    // When
    await inside.loop.startup();
    await inside.loop.startup();
    await outside.loop.startup();
    await outside.loop.startup();

    // Then
    expect(inside.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").all()).toEqual([{ state: "completed", failure_code: null }]);
    expect(outside.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").all()).toEqual([
      { state: "failed", failure_code: "MISSED_RECOVERY_WINDOW" },
    ]);
    inside.db.close();
    outside.db.close();
  });

  it.each([
    ["max_items", { max_items: 0, max_work: 8, max_bytes: 4096 }, "BUDGET_ITEMS_EXHAUSTED"],
    ["max_work", { max_items: 8, max_work: 0, max_bytes: 4096 }, "BUDGET_WORK_EXHAUSTED"],
    ["max_bytes", { max_items: 8, max_work: 8, max_bytes: 0 }, "BUDGET_BYTES_EXHAUSTED"],
  ] as const)("terminates deterministically when %s is exhausted", async (_name, budgets, code) => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(f.db), {
      ...config,
      budgets,
      clock: () => new Date("2026-08-30T22:15:00.000Z"),
      event_source: { drain: () => [] },
      refresh_reader: { read: () => fresh },
    });

    // When
    await loop.cycle();

    // Then
    expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get()).toEqual({ state: "failed", failure_code: code });
    f.db.close();
  });

  it("terminates when the injected deadline is exhausted", async () => {
    // Given
    const f = await fixture("2026-08-30T22:15:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(f.db), {
      ...config,
      deadline_ms: 0,
      clock: () => new Date("2026-08-30T22:15:00.000Z"),
      event_source: { drain: () => [] },
      refresh_reader: { read: () => fresh },
    });

    // When
    await loop.cycle();

    // Then
    expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get()).toEqual({ state: "failed", failure_code: "DEADLINE_EXHAUSTED" });
    f.db.close();
  });
});
