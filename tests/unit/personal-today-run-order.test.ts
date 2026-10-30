import { afterEach, describe, expect, it } from "vitest";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-10-30T00:50:59.000Z");

describe("today execution order", () => {
  const databases: { close(): void }[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("shows the later loop date even when an older miss is stamped later", async () => {
    const db = await migratedTestDatabase(tempDb());
    databases.push(db);
    const store = new DailyLoopStore(db);
    const morning = store.prepare({
      due: { kind: "due", local_date: "2026-10-30", phase: "morning", scheduled_at: "2026-10-29T22:15:00.000Z" },
      created_at: new Date("2026-10-29T22:15:00.000Z"),
      deadline_at: new Date("2026-10-30T10:15:00.000Z"),
      steps: [{ key: "morning_reconcile", sequence: 1 }],
    });
    const evening = store.prepare({
      due: { kind: "due", local_date: "2026-10-29", phase: "evening", scheduled_at: "2026-10-29T12:30:00.000Z" },
      created_at: new Date("2026-10-29T12:30:00.000Z"),
      deadline_at: new Date("2026-10-30T00:30:00.000Z"),
      steps: [{ key: "evening_summary", sequence: 1 }],
    });
    const claim = store.claim({
      run_id: morning, owner_id: "today-order", at: new Date("2026-10-29T23:44:43.240Z"), lease_ms: 300_000,
    });
    const step = store.steps(morning).at(-1);
    if (step === undefined) throw new Error("morning step missing");
    store.completeStep({ claim, step, detail: { step_key: "morning_reconcile", boundary: "no_external_effect" }, at: new Date("2026-10-29T23:44:43.240Z") });
    store.complete(claim, new Date("2026-10-29T23:44:43.240Z"));
    store.omit(evening, "MISSED_RECOVERY_WINDOW", new Date("2026-10-29T23:44:43.246Z"));

    const today = todayProjection(db, NOW);
    expect(today["current_daily_run"]).toMatchObject({
      loop_date: "2026-10-30", phase: "morning", state: "completed", failure_code: null,
    });
    expect(today["last_daily_run"]).toMatchObject({
      loop_date: "2026-10-29", phase: "evening", state: "failed", failure_code: "MISSED_RECOVERY_WINDOW",
    });
    expect(today["omissions"]).toContain("context_no_data");
    expect(today["state"]).toBe("no_data");
  });
});
