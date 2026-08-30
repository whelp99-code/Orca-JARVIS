import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb, DailyControlLoop, DailyLoopStore, classifyDailyLoopInstant, evaluateRefreshContext, kstInstant } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const baseOptions = (clock: () => Date) => ({
  time_zone: "Asia/Seoul" as const,
  owner_id: "linux:stable",
  lease_ms: 60_000,
  deadline_ms: 600_000,
  recovery_window_ms: 7_200_000,
  recovery_lookback_days: 3,
  refresh_freshness_ms: 1_800_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 },
  clock,
  event_source: { drain: () => [] },
  refresh_reader: { read: () => null },
});

describe("Task20 remediation RED", () => {
  it("matches scheduled phases at the exact KST instant and rejects impossible dates", () => {
    // Given
    const scheduled = { kind: "scheduled" } as const;

    // When / Then
    expect(classifyDailyLoopInstant(new Date("2026-08-30T22:14:59.999Z"), scheduled)).toEqual({ kind: "not_due" });
    expect(classifyDailyLoopInstant(new Date("2026-08-30T22:15:00.000Z"), scheduled).kind).toBe("due");
    expect(classifyDailyLoopInstant(new Date("2026-08-30T22:15:00.001Z"), scheduled)).toEqual({ kind: "not_due" });
    expect(() => kstInstant("2026-02-30", 7, 15)).toThrow("DAILY_LOOP_DATE_INVALID");
  });

  it("does not invoke hostile accessors and rejects unsupported refresh schema", () => {
    // Given
    let invoked = 0;
    const hostile = Object.defineProperty({}, "kind", { enumerable: true, get: () => { invoked += 1; throw new Error("getter invoked"); } });
    const schemaTwo = { schema_version: 2, refresh_id: "r", state: "completed", completed_at: "2026-08-30T22:00:00.000Z", protocol_version: 1, capped: false };

    // When / Then
    expect(() => Reflect.apply(classifyDailyLoopInstant, undefined, [new Date("2026-08-30T22:15:00.000Z"), hostile])).toThrow("DAILY_LOOP_EVENT_INVALID");
    expect(invoked).toBe(0);
    expect(Reflect.apply(evaluateRefreshContext, undefined, [schemaTwo, new Date("2026-08-30T22:15:00.000Z"), 1_800_000])).toEqual({
      state: "degraded", reason: "refresh_invalid", refresh_id: null,
    });
  });

  it("permits the stable owner to reclaim at exact expiry with fence n plus one", async () => {
    // Given
    const path = tempDb();
    const db = new AuthorityDb(path);
    await db.migrate();
    let now = new Date("2026-08-30T22:15:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), baseOptions(() => now));
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture not prepared");
    const first = loop.claim(prepared.run_id);

    // When
    now = new Date(first.lease_expires_at);
    const reclaimed = loop.claim(prepared.run_id);

    // Then
    expect(reclaimed.fence).toBe(first.fence + 1);
    db.close();
  });

  it("rejects a forged checkpoint from a second connection and after reopen", async () => {
    // Given
    const path = tempDb();
    const first = new AuthorityDb(path);
    await first.migrate();
    const loop = new DailyControlLoop(new DailyLoopStore(first), baseOptions(() => new Date("2026-08-30T22:15:00.000Z")));
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture not prepared");
    const second = new AuthorityDb(path);

    // When / Then
    expect(() => second.db.prepare(
      "INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run("dlc:forged", prepared.run_id, 1, "completed", `sha256:${"0".repeat(64)}`, 999, "2026-08-30T22:16:00.000Z", "2026-08-30T22:15:01.000Z")).toThrow(/daily loop/);
    second.close();
    first.close();
    const reopened = new AuthorityDb(path);
    expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints WHERE checkpoint_id='dlc:forged'").get()).toEqual({ n: 0 });
    reopened.close();
  });
  it("binds the complete event identity and leaves zero deltas on conflict", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const at = new Date("2026-08-31T03:00:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), baseOptions(() => at));
    const event = { kind: "event", event_id: "identity", occurred_at: at.toISOString(), critical: false, items: 1, work: 2, bytes: 3 } as const;
    loop.prepare(event);
    const before = db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) AS runs,(SELECT count(*) FROM daily_loop_steps) AS steps,(SELECT count(*) FROM daily_loop_checkpoints) AS checkpoints").get();

    // When / Then
    expect(() => loop.prepare({ ...event, bytes: 4 })).toThrow("DAILY_LOOP_IDENTITY_CONFLICT");
    expect(db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) AS runs,(SELECT count(*) FROM daily_loop_steps) AS steps,(SELECT count(*) FROM daily_loop_checkpoints) AS checkpoints").get()).toEqual(before);
    db.close();
  });

  it("persists a quiet deferred event and admits it once after restart at equality", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    let at = new Date("2026-08-31T13:00:00.000Z");
    let events: readonly unknown[] = [{ kind: "event", event_id: "deferred", occurred_at: at.toISOString(), critical: false, items: 1, work: 1, bytes: 1 }];
    const options = { ...baseOptions(() => at), event_source: { drain: () => { const result = events; events = []; return result; } } };
    await new DailyControlLoop(new DailyLoopStore(db), options).cycle();
    expect(db.db.prepare("SELECT state,not_before FROM daily_loop_runs").get()).toEqual({ state: "pending", not_before: "2026-08-31T22:00:00.000Z" });

    // When
    at = new Date("2026-08-31T22:00:00.000Z");
    await new DailyControlLoop(new DailyLoopStore(db), options).cycle();
    await new DailyControlLoop(new DailyLoopStore(db), options).cycle();

    // Then
    expect(db.db.prepare("SELECT state FROM daily_loop_runs").get()).toEqual({ state: "completed" });
    expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_steps").get()).toEqual({ n: 1 });
    db.close();
  });

  it("records the explicit uncertain outcome once with the current fence", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const at = new Date("2026-08-30T22:15:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), baseOptions(() => at));
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("fixture not prepared");
    const claim = loop.claim(prepared.run_id);

    // When
    loop.markUncertain(claim, "EXECUTION_OUTCOME_UNCERTAIN");

    // Then
    expect(db.db.prepare("SELECT state,failure_code,lease_fence FROM daily_loop_runs").get()).toEqual({ state: "uncertain", failure_code: "EXECUTION_OUTCOME_UNCERTAIN", lease_fence: 1 });
    expect(db.db.prepare("SELECT state,lease_fence FROM daily_loop_checkpoints").all()).toEqual([{ state: "uncertain", lease_fence: 1 }]);
    expect(() => loop.markUncertain(claim, "EXECUTION_OUTCOME_UNCERTAIN")).toThrow();
    expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get()).toEqual({ n: 1 });
    db.close();
  });

  it("recomputes every version-one digest from persisted immutable bytes", async () => {
    // Given
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const at = new Date("2026-08-31T12:30:00.000Z");
    const loop = new DailyControlLoop(new DailyLoopStore(db), baseOptions(() => at));

    // When
    await loop.cycle();

    // Then
    const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const run = db.db.prepare("SELECT input_json,input_digest FROM daily_loop_runs WHERE record_version=1").get() as { input_json: string; input_digest: string };
    expect(hash(`orca-jarvis/daily-loop-input/v1\0${run.input_json}`)).toBe(run.input_digest);
    const step = db.db.prepare("SELECT detail_json,evidence_digest,result_digest FROM daily_loop_steps WHERE record_version=1").get() as { detail_json: string; evidence_digest: string; result_digest: string };
    const detail = JSON.parse(step.detail_json);
    expect(hash(canonicalize(detail))).toBe(step.evidence_digest);
    expect(hash(canonicalize({ detail, state: "completed" }))).toBe(step.result_digest);
    const checkpoints = db.db.prepare("SELECT run_id,step_id,sequence,state,previous_digest,lease_fence,detail_json,created_at,checkpoint_digest FROM daily_loop_checkpoints WHERE record_version=1 ORDER BY sequence").all() as Array<Record<string, unknown>>;
    for (const checkpoint of checkpoints) {
      const material = { run_id: checkpoint["run_id"], step_id: checkpoint["step_id"], sequence: checkpoint["sequence"], state: checkpoint["state"], previous_digest: checkpoint["previous_digest"], lease_fence: checkpoint["lease_fence"], detail: JSON.parse(String(checkpoint["detail_json"])), created_at: checkpoint["created_at"] };
      expect(hash(canonicalize(material))).toBe(checkpoint["checkpoint_digest"]);
    }
    db.close();
  });

});
