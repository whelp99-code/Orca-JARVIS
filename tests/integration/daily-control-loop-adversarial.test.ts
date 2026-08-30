import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore, type DailyLoopConfig, type DailyLoopEvent, type RefreshCompletion } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const baseConfig: DailyLoopConfig = {
  time_zone: "Asia/Seoul",
  owner_id: "linux:a",
  lease_ms: 60_000,
  deadline_ms: 600_000,
  recovery_window_ms: 7_200_000,
  refresh_freshness_ms: 1_800_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 },
};
const refresh: RefreshCompletion = {
  schema_version: 1,
  refresh_id: "refresh:boundary",
  state: "completed",
  completed_at: "2026-08-30T22:00:00.000Z",
  protocol_version: 1,
  capped: false,
};
const makeLoop = (db: AuthorityDb, owner: string, clock: () => Date, events: () => readonly DailyLoopEvent[] = () => []): DailyControlLoop =>
  new DailyControlLoop(new DailyLoopStore(db), {
    ...baseConfig,
    owner_id: owner,
    clock,
    event_source: { drain: events },
    refresh_reader: { read: () => refresh },
  });
const tableCounts = (db: AuthorityDb): ReadonlyMap<string, number> =>
  new Map(
    (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
      ({ name }) => [
        name,
        Number(
          (
            db.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as {
              n: number;
            }
          ).n,
        ),
      ],
    ),
  );

describe("Daily Control Loop adversaries", () => {
  it("converges duplicate service owners, repeated instants, rollback, and date rollover", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    let now = new Date("2026-08-30T22:15:00.000Z");
    const first = makeLoop(db, "linux:a", () => now);
    const duplicate = makeLoop(db, "linux:b", () => now);

    // When
    await first.cycle();
    await duplicate.cycle();
    await first.cycle();
    now = new Date("2026-08-30T22:14:00.000Z");
    await first.cycle();
    now = new Date("2026-08-31T22:15:00.000Z");
    await first.cycle();

    // Then
    expect(db.db.prepare("SELECT loop_date,state FROM daily_loop_runs ORDER BY loop_date").all()).toEqual([
      { loop_date: "2026-08-31", state: "completed" },
      { loop_date: "2026-09-01", state: "completed" },
    ]);
    db.close();
  });

  it("returns exact quiet deferral and persists critical bypass without other-table writes", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const before = tableCounts(db);
    const now = () => new Date("2026-08-31T14:00:00.000Z");
    const deferred: DailyLoopEvent = {
      kind: "event",
      event_id: "evt:quiet",
      critical: false,
      items: 1,
      work: 1,
      bytes: 8,
    };
    const critical: DailyLoopEvent = {
      kind: "event",
      event_id: "evt:critical",
      critical: true,
      items: 1,
      work: 1,
      bytes: 8,
    };
    const loop = makeLoop(db, "linux:a", now, () => [deferred, critical]);

    // When
    const result = await loop.cycle();

    // Then
    expect(result.prepared[1]).toEqual({
      kind: "deferred",
      next_allowed_at: "2026-08-31T22:00:00.000Z",
      deferred_key: "daily:2026-09-01:in_day:event:evt_quiet",
    });
    expect(result.completed_run_ids).toHaveLength(1);
    expect(db.db.prepare("SELECT step_key FROM daily_loop_steps").get()).toMatchObject({
      step_key: expect.stringContaining("critical_quiet_hours_bypass"),
    });
    const after = tableCounts(db);
    const allowed = new Set(["daily_loop_runs", "daily_loop_steps", "daily_loop_checkpoints"]);
    for (const [table, count] of before) if (!allowed.has(table)) expect(after.get(table), table).toBe(count);
    db.close();
  });

  it("recovers missed evening once inside and omits once outside the frozen window", async () => {
    // Given
    const insideDb = new AuthorityDb(tempDb());
    const outsideDb = new AuthorityDb(tempDb());
    await insideDb.migrate();
    await outsideDb.migrate();
    const inside = makeLoop(insideDb, "linux:a", () => new Date("2026-08-31T13:00:00.000Z"));
    const outside = new DailyControlLoop(new DailyLoopStore(outsideDb), {
      ...baseConfig,
      recovery_window_ms: 60 * 60_000,
      clock: () => new Date("2026-08-31T14:00:00.000Z"),
      event_source: { drain: () => [] },
      refresh_reader: { read: () => refresh },
    });

    // When
    await inside.startup();
    await inside.startup();
    await outside.startup();
    await outside.startup();

    // Then
    expect(insideDb.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE idempotency_key LIKE '%evening%'").all()).toEqual([
      { state: "completed", failure_code: null },
    ]);
    expect(outsideDb.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE idempotency_key LIKE '%evening%'").all()).toEqual([
      { state: "failed", failure_code: "MISSED_RECOVERY_WINDOW" },
    ]);
    insideDb.close();
    outsideDb.close();
  });

  it("lets migration-033 triggers reject immutable checkpoints and invalid state/fence transitions", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const loop = makeLoop(db, "linux:a", () => new Date("2026-08-30T22:15:00.000Z"));
    await loop.cycle();
    const checkpoint = db.db.prepare("SELECT checkpoint_id FROM daily_loop_checkpoints LIMIT 1").get() as { checkpoint_id: string };
    const run = db.db.prepare("SELECT run_id FROM daily_loop_runs LIMIT 1").get() as { run_id: string };

    // When / Then
    expect(() => db.db.prepare("UPDATE daily_loop_checkpoints SET state='failed' WHERE checkpoint_id=?").run(checkpoint.checkpoint_id)).toThrow(
      "immutable daily loop checkpoint",
    );
    expect(() => db.db.prepare("DELETE FROM daily_loop_checkpoints WHERE checkpoint_id=?").run(checkpoint.checkpoint_id)).toThrow(
      "immutable daily loop checkpoint",
    );
    expect(() =>
      db.db.prepare("UPDATE daily_loop_runs SET state='running',lease_fence=99,updated_at='2026-08-30T22:15:01.000Z' WHERE run_id=?").run(run.run_id),
    ).toThrow(/daily loop/);
    expect(() =>
      db.db
        .prepare(
          "INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest," +
            "lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run("dlc:stale", run.run_id, 99, "running", "sha256:stale", 1, "2026-08-30T22:16:00.000Z", "2026-08-30T22:15:01.000Z"),
    ).toThrow(/daily loop stale checkpoint fence|daily loop checkpoint chain invalid/);
    db.close();
  });

  it("has no Mac, model, pipeline, dispatch, notification, or external authority dependency", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const loop = makeLoop(db, "linux:sole-authority", () => new Date("2026-08-30T22:15:00.000Z"));

    // When
    const result = await loop.cycle();

    // Then
    expect(result.completed_run_ids).toHaveLength(1);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM control_command_requests").get()).toEqual({ n: 0 });
    db.close();
  });
});
