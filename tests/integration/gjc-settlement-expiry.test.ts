import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorityDb, GjcRuntimeService } from "../../src/index.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";

const started = "2026-09-07T00:00:00.000Z";
const expires = "2026-09-07T00:01:00.000Z";
const late = "2026-09-07T00:02:00.000Z";
let db: AuthorityDb;

beforeEach(async () => {
  db = new AuthorityDb(":memory:");
  await db.migrate();
  db.configureGjc(process.cwd(), "s", true);
});
afterEach(() => db.close());

function envelope(body: unknown) {
  return { exitCode: 0, stdout: [
    { jsonrpc: "2.0", id: 1, result: {
      protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" },
    } },
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
  ].map(value => JSON.stringify(value)).join("\n") };
}

describe("GJC settlement at the lease boundary", () => {
  it.each([expires, late, "invalid-clock"])("rejects settlement at %s without an event or receipt", now => {
    const id = db.createGjcIntent("dispatch", {}, "dispatch", undefined, started);
    const claimed = db.claimGjcIntent(id, "worker", started)!;
    expect(() => db.settleGjcIntent(id, Number(claimed.lease_fence), {
      status: "completed", receipt: { session_id: "s", turn_id: "t" },
    }, now)).toThrow("GJC_STALE_LEASE");
    expect(db.db.prepare("SELECT state,receipt_json FROM gjc_intents WHERE intent_id=?").get(id))
      .toEqual({ state: "claimed", receipt_json: null });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_dispatch_receipts").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intent_events WHERE event_type='completed'").get()).toEqual({ n: 0 });
  });

  it("accepts a current claim just before expiry", () => {
    const id = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "timely", undefined, started);
    const claimed = db.claimGjcIntent(id, "worker", started)!;
    db.settleGjcIntent(id, Number(claimed.lease_fence), { status: "completed" }, "2026-09-07T00:00:59.999Z");
    expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(id)).toEqual({ state: "completed" });
  });

  it("does not call the coordinator when the intent has already expired", async () => {
    db.createGjcIntent("dispatch", {}, "pre-call", undefined, started);
    let calls = 0;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
      calls++;
      return envelope({});
    }, true), "worker", undefined, () => new Date(late));
    await expect(service.once(started)).rejects.toMatchObject({ code: "GJC_STALE_LEASE" });
    expect(calls).toBe(0);
  });

  it("does not settle an exception using the operation start time", async () => {
    const id = db.createGjcIntent("dispatch", {}, "late-error", undefined, started);
    let now = started;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
      now = late;
      throw new Error("coordinator connection lost");
    }, true), "worker", undefined, () => new Date(now));
    await expect(service.once(started)).rejects.toMatchObject({ code: "GJC_STALE_LEASE" });
    expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(id)).toEqual({ state: "claimed" });
  });

  it("rolls back an answer receipt and completion if the question update fails", async () => {
    const sync = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "question", undefined, started);
    const claim = db.claimGjcIntent(sync, "seed", started)!;
    db.settleGjcIntent(sync, Number(claim.lease_fence), { status: "completed" }, started);
    db.bindGjcQuestion(sync, "q", { session_id: "s", turn_id: "t", question_id: "q" }, started);
    const id = db.createGjcQuestionAnswerIntent("q", {
      session_id: "s", turn_id: "t", answer_binding: { choice: "yes" }, answer: "yes",
    }, "answer", started);
    db.db.exec(`CREATE TRIGGER fail_answer BEFORE INSERT ON gjc_question_answers
      BEGIN SELECT RAISE(ABORT, 'injected answer write failure'); END`);
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => envelope({
      ok: true,
      question: { status: "completed", session_id: "s", turn_id: "t", question_id: "q", answer: "yes" },
      turn: { session_id: "s", turn_id: "t" },
    }), true), "worker", undefined, () => new Date(started));
    await expect(service.once()).resolves.toMatchObject({ state: "uncertain" });
    expect(db.db.prepare("SELECT state,receipt_json FROM gjc_intents WHERE intent_id=?").get(id))
      .toEqual({ state: "uncertain", receipt_json: null });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_answer_receipts").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT state FROM gjc_questions WHERE question_id='q'").get()).toEqual({ state: "open" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intent_events WHERE intent_id=? AND event_type='completed'").get(id))
      .toEqual({ n: 0 });
  });

  it.each(["sync", "dispatch", "answer"] as const)("rejects a late %s response even with a valid runtime heartbeat", async kind => {
    const id = db.createGjcIntent(kind, { session_id: "s", turn_id: "t" }, "late", undefined, started);
    let now = started;
    let calls = 0;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
      calls++;
      // Simulate a runtime heartbeat maintained independently while the intent lease expires.
      db.db.prepare("UPDATE gjc_runtime_leases SET expires_at=?").run("2026-09-07T00:05:00.000Z");
      now = late;
      return { exitCode: 0, stdout: [
        { jsonrpc: "2.0", id: 1, result: {
          protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" },
        } },
        { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({
          ok: true, turn: { status: "completed", session_id: "s", turn_id: "t" },
        }) }] } },
      ].map(value => JSON.stringify(value)).join("\n") };
    }, true), "worker", undefined, () => new Date(now));
    await expect(service.once(started)).rejects.toMatchObject({ code: "GJC_STALE_LEASE" });
    expect(calls).toBe(1);
    expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(id)).toEqual({ state: "claimed" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intent_events WHERE event_type='completed'").get()).toEqual({ n: 0 });
    expect(db.recoverExpiredGjcIntents(late)).toBe(1);
    expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(id))
      .toEqual({ state: kind === "sync" ? "pending" : "uncertain" });
    for (const table of ["gjc_questions", "gjc_answer_receipts", "gjc_dispatch_receipts"])
      expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});
