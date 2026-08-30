import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyLoopStore, EveningCloseoutStore, generateEveningCloseout, parseEveningCloseoutInput } from "../../src/index.js";
import { initialized } from "../helpers.js";

const T0 = new Date("2026-08-30T12:00:00.000Z"); const T1 = new Date("2026-08-30T12:01:00.000Z");
function prepare(loop: DailyLoopStore): string { return loop.prepare({ due: { kind: "due", local_date: "2026-08-30", phase: "evening",
  scheduled_at: T0.toISOString() }, created_at: T0, deadline_at: new Date("2026-08-30T13:00:00.000Z"),
  steps: [{ key: "evening_summary", sequence: 1 }] }); }
function artifact(runId: string, correlationId: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  return generateEveningCloseout(parseEveningCloseoutInput({ schema_version: 1, run_id: runId, correlation_id: correlationId,
    local_date: "2026-08-30", generated_at: T1.toISOString(), source_readiness: "no_data", source_omissions: [], records: [],
    decisions: [], memory_candidates: [], tomorrow_actions: [], risks: [], limits: null }),
  { key_id: "closeout-test", private_key: privateKey, clock: () => new Date(T1) });
}
describe("evening closeout persistence", () => {
  it("Given a current fence When settled twice Then only exact daily lifecycle is idempotent", async () => {
    const db = await initialized(); const keys = generateKeyPairSync("ed25519"); const loop = new DailyLoopStore(db); const runId = prepare(loop);
    const correlation = String((db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string }).correlation_id);
    const claim = loop.claim({ run_id: runId, owner_id: "closeout-owner", at: T1, lease_ms: 600_000 });
    const store = new EveningCloseoutStore(db, { key_id: "closeout-test", public_key: keys.publicKey }); const value = artifact(runId, correlation, keys.privateKey);
    expect(store.settle({ claim, artifact: value, at: T1 })).toBe(true);
    expect(store.settle({ claim, artifact: value, at: T1 })).toBe(false);
    expect(store.read(runId)).toEqual(value);
    expect(db.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(runId)).toEqual({ state: "completed" }); db.close();
  });
  it("Given a crash after artifact persistence When reopened Then resumes once and changed bytes conflict", async () => {
    const db = await initialized(); const filename = db.filename; const keys = generateKeyPairSync("ed25519"); const loop = new DailyLoopStore(db); const runId = prepare(loop);
    const correlation = String((db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string }).correlation_id);
    const claim = loop.claim({ run_id: runId, owner_id: "closeout-owner", at: T1, lease_ms: 600_000 }); const value = artifact(runId, correlation, keys.privateKey);
    const crashing = new EveningCloseoutStore(db, { key_id: "closeout-test", public_key: keys.publicKey }, { after_artifact_persisted: () => { throw new Error("injected crash"); } });
    expect(() => crashing.settle({ claim, artifact: value, at: T1 })).toThrow("injected crash"); db.close();
    const reopened = new AuthorityDb(filename); const recovered = new EveningCloseoutStore(reopened, { key_id: "closeout-test", public_key: keys.publicKey });
    expect(recovered.settle({ claim, artifact: value, at: T1 })).toBe(true);
    expect(() => recovered.settle({ claim, artifact: { ...value, signature: `${value.signature}x` }, at: T1 }))
      .toThrow("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_steps WHERE run_id=?").get(runId)).toEqual({ n: 1 }); reopened.close();
  });
});
