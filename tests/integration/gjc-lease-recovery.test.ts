import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, GjcRuntimeService } from "../../src/index.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { tempDb } from "../helpers.js";

const started = "2026-09-07T00:00:00.000Z";
const recovered = "2026-09-07T00:02:00.000Z";
const envelope = (body: unknown) => ({
  stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
    protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" },
  } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {
    content: [{ type: "text", text: JSON.stringify(body) }],
  } })}\n`, exitCode: 0,
});

async function opened(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  db.configureGjc(process.cwd(), "session", true);
  return db;
}

function state(db: AuthorityDb, id: string): unknown {
  return db.db.prepare("SELECT state,attempts,failure_code FROM gjc_intents WHERE intent_id=?").get(id);
}

describe("GJC recovery after worker loss", () => {
  it("resumes an expired read even when no pending work remains", async () => {
    const db = await opened();
    try {
      const id = db.createGjcIntent("sync", { session_id: "session", turn_id: "turn" }, "read", undefined, started);
      db.claimGjcIntent(id, "lost-worker", started);
      const calls: string[] = [];
      const client = new GjcCoordinatorClient(async run => {
        const name = JSON.parse(run.stdin.trim().split("\n")[2]!).params.name as string;
        calls.push(name);
        return envelope(name === "gjc_coordinator_list_questions" ? { questions: [] } : {
          ok: true, turn: { status: "completed", session_id: "session", turn_id: "turn" },
        });
      });
      const service = new GjcRuntimeService(db, client, "replacement", undefined, () => new Date(recovered));
      expect(await service.once(recovered)).toMatchObject({ processed: id, state: "completed" });
      expect(state(db, id)).toMatchObject({ state: "completed", attempts: 2 });
      expect(calls).toEqual(["gjc_coordinator_read_turn", "gjc_coordinator_list_questions"]);
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });

  it.each(["dispatch", "answer"] as const)("never resends an expired %s, including through direct claiming", async kind => {
    const db = await opened();
    try {
      const id = db.createGjcIntent(kind, { session_id: "session" }, kind, undefined, started);
      const old = db.claimGjcIntent(id, "lost-worker", started)!;
      expect(db.claimGjcIntent(id, "replacement", recovered)).toBeNull();
      expect(state(db, id)).toMatchObject({ state: "uncertain", attempts: 1, failure_code: "GJC_CLAIM_EXPIRED_UNCERTAIN" });
      expect(() => db.settleGjcIntent(id, Number(old.lease_fence), { status: "completed" }, recovered))
        .toThrow("GJC_STALE_LEASE");
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intent_events WHERE intent_id=? AND event_type='lease_expired'")
        .get(id)).toEqual({ n: 1 });
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });

  it("settles expired mutations without pending work or any coordinator call", async () => {
    const db = await opened();
    try {
      const id = db.createGjcIntent("dispatch", {}, "uncertain-dispatch", undefined, started);
      db.claimGjcIntent(id, "lost-worker", started);
      let calls = 0;
      const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
        calls++;
        throw new Error("must not resend");
      }), "replacement", undefined, () => new Date(recovered));
      expect(await service.once(recovered)).toEqual({ processed: null, state: null });
      expect(await service.once(recovered)).toEqual({ processed: null, state: null });
      expect(calls).toBe(0);
      expect(state(db, id)).toMatchObject({ state: "uncertain", attempts: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intent_events WHERE event_type='lease_expired'").get())
        .toEqual({ n: 1 });
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });

  it("preserves a live claim and a competing runtime lease", async () => {
    const db = await opened();
    try {
      const id = db.createGjcIntent("sync", { session_id: "session", turn_id: "turn" }, "live", undefined, started);
      db.claimGjcIntent(id, "worker", started);
      expect(db.claimGjcIntent(id, "other", "2026-09-07T00:00:30.000Z")).toBeNull();
      expect(state(db, id)).toMatchObject({ state: "claimed", attempts: 1 });
      db.claimGjcRuntimeLease("owner", recovered);
      const service = new GjcRuntimeService(db, new GjcCoordinatorClient(), "other");
      expect(await service.once(recovered)).toEqual({ processed: null, state: "leased" });
      expect(state(db, id)).toMatchObject({ state: "claimed", attempts: 1 });
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });
});
