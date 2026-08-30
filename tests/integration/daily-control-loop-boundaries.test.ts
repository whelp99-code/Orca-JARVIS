import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore, canonicalDailyLoopKey, evaluateRefreshContext } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const options = (clock: () => Date, drain: () => unknown = () => []) => ({
  time_zone: "Asia/Seoul" as const, owner_id: "linux:stable", lease_ms: 1_000, deadline_ms: 60_000,
  recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock,
  event_source: { drain }, refresh_reader: { read: () => null },
});

describe("Daily Control Loop closed public boundaries", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 86_400_001])("rejects malformed refresh freshness %s", freshness => {
    // Given / When / Then
    expect(() => Reflect.apply(evaluateRefreshContext, undefined, [null, new Date("2026-08-30T22:15:00.000Z"), freshness])).toThrow("DAILY_LOOP_CONFIG_INVALID");
  });

  it.each([
    ["2026-02-30", "morning", undefined], ["2026-08-31", "night", undefined], ["2026-08-31", "in_day", "\u0000event"],
  ])("rejects an invalid canonical-key input %#", (date, phase, identity) => {
    // Given / When / Then
    expect(() => Reflect.apply(canonicalDailyLoopKey, undefined, [date, phase, identity])).toThrow();
  });

  it("enforces refresh freshness equality and plus one millisecond", () => {
    // Given
    const at = new Date("2026-08-30T22:15:00.000Z"); const refresh = { schema_version: 1, refresh_id: "equal", state: "completed", completed_at: "2026-08-30T22:14:00.000Z", protocol_version: 1, capped: false };
    // When / Then
    expect(evaluateRefreshContext(refresh, at, 60_000).reason).toBe("refresh_fresh"); expect(evaluateRefreshContext(refresh, at, 59_999).reason).toBe("refresh_stale"); expect(() => canonicalDailyLoopKey("2026-08-31", "in_day")).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(() => canonicalDailyLoopKey("2026-08-31", "morning", "event")).toThrow("DAILY_LOOP_EVENT_INVALID");
  });

  it.each(["getter", "symbol", "non_enumerable", "custom_prototype", "proxy"])("degrades hostile refresh %s without invoking accessors", kind => {
    // Given
    let invoked = 0; const base = { schema_version: 1, refresh_id: "r", state: "completed", completed_at: "2026-08-30T22:00:00.000Z", protocol_version: 1, capped: false }; let hostile: unknown;
    if (kind === "getter") hostile = Object.defineProperty({ ...base }, "state", { enumerable: true, get: () => { invoked++; throw new Error("getter"); } });
    else if (kind === "symbol") hostile = { ...base, [Symbol("x")]: true };
    else if (kind === "non_enumerable") hostile = Object.defineProperty({ ...base }, "state", { value: "completed", enumerable: false });
    else if (kind === "custom_prototype") hostile = Object.assign(Object.create({ inherited: true }), base);
    else hostile = new Proxy(base, { ownKeys: () => { throw new Error("proxy"); } });
    // When / Then
    expect(evaluateRefreshContext(hostile, new Date("2026-08-30T22:15:00.000Z"), 60_000)).toEqual({ state: "degraded", reason: "refresh_invalid", refresh_id: null }); expect(invoked).toBe(0);
  });

  it("never invokes a hostile claim accessor", async () => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => new Date("2026-08-30T22:15:00.000Z")));
    let invoked = 0;
    const hostile = Object.defineProperty({}, "run_id", { enumerable: true, get: () => { invoked++; throw new Error("claim getter"); } });

    // When / Then
    expect(() => Reflect.apply(loop.runNext, loop, [hostile])).toThrow("DAILY_LOOP_EVENT_INVALID");
    expect(invoked).toBe(0);
    db.close();
  });

  it("returns the durable run identity for a deferred event", async () => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const at = new Date("2026-08-31T13:00:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at));

    // When
    const result = loop.prepare({ kind: "event", event_id: "defer-id", occurred_at: at.toISOString(), critical: false, items: 1, work: 1, bytes: 1 });

    // Then
    expect(result).toMatchObject({ kind: "deferred", run_id: expect.stringMatching(/^dlr:/) });
    expect(db.db.prepare("SELECT run_id FROM daily_loop_runs").get()).toEqual({ run_id: result.kind === "deferred" ? result.run_id : "missing" });
    db.close();
  });

  it("rebinds an interrupted step to the exact current fence after two expired reclaims", async () => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate();
    let at = new Date("2026-08-30T22:15:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at));
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture not prepared");
    const first = loop.claim(prepared.run_id);
    const evidence = `sha256:${createHash("sha256").update("{}").digest("hex")}`;
    db.db.prepare("UPDATE daily_loop_steps SET state='claimed',transition_fence=1,detail_json='{}',evidence_digest=?,updated_at=? WHERE run_id=? AND sequence=1")
      .run(evidence, at.toISOString(), prepared.run_id);
    at = new Date(first.lease_expires_at); const second = loop.claim(prepared.run_id);
    at = new Date(second.lease_expires_at); const third = loop.claim(prepared.run_id);

    // When
    loop.runNext(third);

    // Then
    expect(db.db.prepare("SELECT transition_fence,state FROM daily_loop_steps WHERE run_id=? AND sequence=1").get(prepared.run_id)).toEqual({ transition_fence: 3, state: "completed" });
    db.close();
  });
});


describe("DailyLoopStore exported runtime boundaries", () => {
  it.each(["prepare", "claim", "appendCheckpoint", "completeStep"] as const)("rejects hostile %s records without invoking accessors or writing", async method => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate(); const store = new DailyLoopStore(db); let invoked = 0; const hostile = Object.defineProperty({}, method === "claim" ? "run_id" : "detail", { enumerable: true, get: () => { invoked++; throw new Error("getter"); } }); const before = db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) runs,(SELECT count(*) FROM daily_loop_steps) steps,(SELECT count(*) FROM daily_loop_checkpoints) checkpoints").get();
    // When / Then
    expect(() => Reflect.apply(store[method], store, [hostile])).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(invoked).toBe(0); expect(db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) runs,(SELECT count(*) FROM daily_loop_steps) steps,(SELECT count(*) FROM daily_loop_checkpoints) checkpoints").get()).toEqual(before); db.close();
  });

  it.each(["start", "fail", "uncertain", "complete"] as const)("rejects hostile %s claims without invoking accessors or writing", async method => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate(); const store = new DailyLoopStore(db); let invoked = 0; const claim = Object.defineProperty({}, "run_id", { enumerable: true, get: () => { invoked++; throw new Error("getter"); } }); const before = db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get();
    // When / Then
    const args = method === "fail" ? [claim, "DEADLINE_EXHAUSTED", new Date()] : method === "uncertain" ? [claim, "EXECUTION_OUTCOME_UNCERTAIN", new Date()] : [claim, new Date()]; expect(() => Reflect.apply(store[method], store, args)).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(invoked).toBe(0); expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get()).toEqual(before); db.close();
  });

  it("rejects malformed due/steps/omit and scalar run/date inputs with zero writes", async () => {
    // Given
    const db = new AuthorityDb(tempDb()); await db.migrate(); const store = new DailyLoopStore(db); const before = db.db.prepare("SELECT count(*) AS n FROM daily_loop_runs").get(); let invoked = 0; const cost = Object.defineProperty({}, "items", { enumerable: true, get: () => { invoked++; throw new Error("cost getter"); } });
    // When / Then
    expect(() => store.prepare({ due: { kind: "due", local_date: "2026-08-31", phase: "in_day", scheduled_at: "2026-08-31T03:00:00.000Z", occurred_at: "2026-08-31T03:00:00.000Z", event_id: "x", critical: false, event_cost: cost }, created_at: new Date("2026-08-31T03:00:00.000Z"), deadline_at: new Date("2026-08-31T03:01:00.000Z"), steps: [] })).toThrow("DAILY_LOOP_EVENT_INVALID");
    expect(() => store.claim({ run_id: "dlr:x", owner_id: "x", at: "not-a-date", lease_ms: 1 })).toThrow("DAILY_LOOP_INSTANT_INVALID"); expect(() => store.claim({ run_id: "dlr:x", owner_id: "x", at: new Date(), lease_ms: 1.5 })).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(() => store.due(new Date(Number.NaN))).toThrow("DAILY_LOOP_INSTANT_INVALID"); expect(() => store.steps(Object.assign(Object.create({ inherited: true }), { value: "dlr:x" }))).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(() => store.omit({ run_id: "dlr:x" }, "MISSED_RECOVERY_WINDOW", new Date())).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(invoked).toBe(0); expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_runs").get()).toEqual(before); db.close();
  });
});
