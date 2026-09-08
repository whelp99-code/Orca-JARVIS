import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb } from "../../src/db.js";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { generateMorningBrief, parseMorningBriefInput } from "../../src/morning-brief.js";
import { morningInput, morningRecord } from "../fixtures/morning-brief-record.js";
import { tempDb } from "../helpers.js";

const at = new Date("2026-08-28T12:00:00.000Z");
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
async function persisted(detail: unknown, date = "2026-08-28") {
  const db = new AuthorityDb(tempDb()); opened.push(db); await db.migrate();
  const loop = new DailyLoopStore(db);
  const scheduled = new Date(`${date}T12:00:00.000Z`);
  const run = loop.prepare({ due: { kind: "due", local_date: date, phase: "morning", scheduled_at: scheduled.toISOString() },
    created_at: scheduled, deadline_at: new Date(scheduled.getTime() + 600_000), steps: [{ key: "morning_reconcile", sequence: 1 }] });
  const claim = loop.claim({ run_id: run, owner_id: "morning-reader", at: scheduled, lease_ms: 300_000 });
  const step = loop.steps(run)[0]; if (!step) throw new Error("STEP_MISSING");
  loop.completeStep({ claim, step, detail, at: scheduled });
  return db;
}
const brief = () => generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord()])));
function rehash(value: Record<string, unknown>) {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => !["brief_id", "canonical_digest"].includes(key)));
  const canonical_digest = hash(core);
  return { ...core, canonical_digest,
    brief_id: `morning-brief:v2:${hash({ generated_at: value["generated_at"], canonical_digest }).slice(7)}` };
}

describe("persisted morning brief read boundary", () => {
  it("rejects digest-valid malformed items without writing during Today reads", async () => {
    const db = await persisted(rehash({ ...brief(), needs_you_first: [{ copy: "unverified" }] }));
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    expect(() => todayProjection(db, at)).toThrow("MORNING_BRIEF_INTEGRITY_FAILURE");
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
  it("rejects a valid brief attached to another daily date", async () => {
    const db = await persisted(brief(), "2026-08-29");
    expect(() => todayProjection(db, at)).toThrow("PERSONAL_TODAY_INTEGRITY_FAILURE");
  });
  it("does not label no-data as degraded", async () => {
    const input = { ...morningInput([]), context_readiness: "no_data" };
    const db = await persisted(generateMorningBrief(parseMorningBriefInput(input)));
    expect(todayProjection(db, at)["brief"]).toMatchObject({ state: "no_data", item_count: 0 });
  });
  it("reads a generated brief without DB writes and keeps legacy placeholders as no data", async () => {
    const db = await persisted(brief());
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    expect(todayProjection(db, at)["brief"]).toMatchObject({ state: "ready", item_count: 1, brief_id: brief().brief_id });
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    const legacy = await persisted({ step_key: "morning_reconcile", boundary: "no_external_effect" });
    expect(todayProjection(legacy, at)["brief"]).toEqual({ state: "no_data", item_count: 0, brief_id: null, generated_at: null });
  });
});
