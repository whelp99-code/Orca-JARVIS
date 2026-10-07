import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateAttention, attentionQueue, type AttentionRow } from "../../src/workboard/attention.js";
import { applyAttentionEvent, type AttentionEvent } from "../../src/workboard/state.js";
import { WorkboardStore } from "../../src/workboard/store.js";

const origin = "2026-09-24T00:00:00.000Z";
const clock = (seconds: number) => new Date(Date.parse(origin) + seconds * 1000);
const row = (overrides: Partial<AttentionRow> = {}): AttentionRow => ({
  work_id: "a", state: "running", received_at: origin, source_at: origin,
  last_successful_observation: origin, warning: null, last_progress_received_at: origin,
  ...overrides,
});

describe("workboard attention", () => {
  it("keeps 179 seconds fresh and makes 180 seconds unconfirmed, disabling snapshot actions", () => {
    expect(evaluateAttention(row(), clock(179))).toMatchObject({ freshness: "fresh", actionsEnabled: true });
    expect(evaluateAttention(row(), clock(180))).toMatchObject({ freshness: "unconfirmed", rank: 2, actionsEnabled: false });
  });
  it("does not refresh last success on a failed scan heartbeat; offline is not failed", () => {
    const db = new Database(":memory:");
    try {
      const store = new WorkboardStore(db);
      store.ingest({ source: { host: "h", app: "a", scope: "s", generation: "g" }, eventId: "e", sequence: 1,
        sessionId: "session", incarnation: "one", taskId: null, receivedAt: origin, sourceAt: origin,
        state: "running", summary: "Working", evidenceRef: "source://e" });
      store.outage("h:a:s:g", "offline");
      const observed = db.prepare("SELECT last_successful_observation,warning FROM workboard_sources").get() as {last_successful_observation: string; warning: string};
      expect(observed.last_successful_observation).toBe(origin);
      expect(evaluateAttention(row({ warning: observed.warning, last_successful_observation: observed.last_successful_observation }), clock(180)))
        .toMatchObject({ disposition: "running", freshness: "unconfirmed", actionsEnabled: false });
    } finally { db.close(); }
  });
  it("flags a ten-minute progress gap without declaring failure or restarting; explicit waits retain reasons", () => {
    expect(evaluateAttention(row({ last_successful_observation: clock(599).toISOString() }), clock(599)).rank).toBeNull();
    expect(evaluateAttention(row({ last_successful_observation: clock(600).toISOString() }), clock(600)))
      .toMatchObject({ disposition: "running", rank: 2, reasons: ["stall_suspected"] });
    expect(evaluateAttention(row({ last_successful_observation: clock(600).toISOString(), wait_kind: "long_running", wait_reason: "Waiting for remote build" }), clock(600)))
      .toMatchObject({ rank: 2, waitReason: "Waiting for remote build" });
  });
  it("keeps a cancel delivery pending when the source claims completion, until verified", () => {
    expect(evaluateAttention(row({ state: "claimed_done", action_delivery: "cancel_requested" }), clock(0)))
      .toMatchObject({ disposition: "claimed_done", actionDelivery: "cancel_requested", rank: 3, actionsEnabled: false });
    expect(evaluateAttention(row({ state: "verified", action_delivery: "delivered" }), clock(0)).rank).toBeNull();
  });
  it("uses received time, not skewed source time; delayed older events cannot roll back state or progress", () => {
    expect(evaluateAttention(row({ source_at: clock(5000).toISOString(), received_at: clock(179).toISOString(), last_successful_observation: clock(179).toISOString(), last_progress_received_at: clock(179).toISOString() }), clock(180)).freshness).toBe("fresh");
    const newer: AttentionEvent = { sequence: 2, disposition: "claimed_done", attempt: "stopped", actionDelivery: "cancel_requested", receivedAt: clock(20).toISOString(), progress: true };
    const current = applyAttentionEvent(null, newer);
    expect(applyAttentionEvent(current, { ...newer, sequence: 1, disposition: "running", receivedAt: clock(30).toISOString() })).toEqual(current);
  });
  it("sorts valid decisions, blocks, gaps, then verification; missing metadata is not invented", () => {
    const queue = attentionQueue([
      row({ work_id: "verify", state: "claimed_done" }),
      row({ work_id: "gap", last_successful_observation: null }),
      row({ work_id: "block", state: "blocked" }),
      row({ work_id: "decision-late", state: "waiting", wait_kind: "user_decision", decision_valid: 1, deadline_at: clock(500).toISOString() }),
      row({ work_id: "decision-early", state: "waiting", wait_kind: "user_decision", decision_valid: 1, deadline_at: clock(400).toISOString() }),
      row({ work_id: "unvalidated", state: "waiting", wait_kind: "user_decision", decision_valid: 0 }),
    ], clock(0));
    expect(queue.map(item => item.workId)).toEqual(["decision-early", "decision-late", "block", "gap", "verify"]);
    expect(queue[2]).toMatchObject({ deadlineAt: null, impact: null });
  });
  it("loads persisted projection without changing the authority tables", async () => {
    const db = new Database(":memory:");
    try {
      new WorkboardStore(db);
      db.exec(readFileSync(resolve("migrations/101_workboard_attention.sql"), "utf8"));
      const { readWorkboard } = await import("../../src/workboard/projection.js");
      expect(readWorkboard(db, clock(0))).toEqual({ works: [], attention: [], sources: [] });
      const store = new WorkboardStore(db);
      store.ingest({ source: { host: "h", app: "a", scope: "s", generation: "g" }, eventId: "e", sequence: 1,
        sessionId: "session", incarnation: "one", taskId: null, receivedAt: origin, sourceAt: origin,
        state: "running", summary: "Working", evidenceRef: "source://e" });
      const workId = store.works()[0]!.work_id;
      db.prepare(`INSERT INTO workboard_attention(work_id,sequence,last_progress_received_at,attempt_execution,wait_kind,wait_reason)
        VALUES(?,1,?,'waiting','long_running','Remote build')`).run(workId, origin);
      const projection = readWorkboard(db, clock(600));
      expect(projection.works[0]!.attention).toMatchObject({ attemptExecution: "waiting", waitReason: "Remote build", disposition: "running" });
      expect(projection.attention[0]).toMatchObject({ rank: 2, freshness: "unconfirmed", actionsEnabled: false });
      expect(store.works()[0]!.state).toBe("running");
    } finally { db.close(); }
  });
});
