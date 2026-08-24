import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoutineDispatcher } from "../../src/routines/dispatcher.js";
import { RoutineScheduler } from "../../src/routines/scheduler.js";
import { RoutineStore } from "../../src/routines/store.js";
import type { Routine } from "../../src/routines/types.js";
import { presentRoutine } from "../../shells/cli-jaw/src/jarvis/routine-ui.js";

function clock(start: number) {
  let now = start;
  return { now: () => now, set: (value: number) => { now = value; } };
}

function base(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    owner: "local",
    project: "proj",
    timezone: "America/New_York",
    schedule: { kind: "interval", everyMs: 60 * 60 * 1000 },
    action: { kind: "notify", template: "ping" },
    riskTier: 0,
    environment: "local",
    enabled: true,
    nextDue: 1_000,
    missedRunPolicy: "run_once",
    catchUpCap: 3,
    generation: "g1",
    ...overrides,
  };
}

describe("fenced routines", () => {
  it("advances fake clock through due, DST, restart without duplicate runs", () => {
    const file = join(process.cwd(), ".omo/evidence/integration/13", `happy-store-${Date.now()}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    const time = clock(1_000);
    const store = new RoutineStore(file);
    store.put(base());
    const scheduler = new RoutineScheduler(store, time);
    const dispatcher = new RoutineDispatcher(store, scheduler, time);
    expect(dispatcher.tick("r1", "local", "g1")).toEqual(["notify"]);
    time.set(1_000 + 60 * 60 * 1000);
    const store2 = new RoutineStore(file);
    const again = new RoutineDispatcher(store2, new RoutineScheduler(store2, time), time);
    expect(again.tick("r1", "local", "g1")).toEqual(["notify"]);
    const dst = new RoutineStore();
    dst.put(base({
      id: "dst",
      nextDue: Date.parse("2026-03-08T06:00:00.000Z"),
      schedule: { kind: "daily", hour: 3, timezone: "America/New_York" },
    }));
    const dstClock = clock(Date.parse("2026-03-08T07:00:00.000Z"));
    const dstSched = new RoutineScheduler(dst, dstClock);
    const fence = dstSched.claimDue("dst", "local", "g1");
    expect(fence).toBe(1);
    expect(presentRoutine(store2.get("r1")).enabled).toBe(true);
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/13/happy.json"), `${JSON.stringify({
      runs: store2.runLog.map(run => ({ kind: run.kind, owner: run.owner, fence: run.fence })),
      notifications: store2.notificationKeys,
    }, null, 2)}\n`);
  });

  it("creates approval for protected actions and refuses split-owner, overflow, stale generation", () => {
    const time = clock(5_000);
    const store = new RoutineStore();
    store.put(base({ action: { kind: "protected", template: "rm" }, riskTier: 3, nextDue: 1_000, missedRunPolicy: "catch_up_bounded", catchUpCap: 1 }));
    const dispatcher = new RoutineDispatcher(store, new RoutineScheduler(store, time), time);
    const kinds = dispatcher.tick("r1", "local", "g1");
    expect(kinds).toEqual(["approval_request"]);
    const codes: string[] = [];
    const capture = (fn: () => void) => {
      try { fn(); codes.push("UNEXPECTED"); } catch (error) { codes.push(error instanceof Error ? error.message : "unknown"); }
    };
    capture(() => new RoutineScheduler(store, time).claimDue("r1", "jm-server", "g1"));
    store.put(base({ id: "r2", nextDue: 1_000, generation: "g1", missedRunPolicy: "catch_up_bounded", catchUpCap: 0 }));
    capture(() => new RoutineDispatcher(store, new RoutineScheduler(store, time), time).tick("r2", "local", "g1"));
    store.put(base({ id: "r3", nextDue: 1_000, generation: "old" }));
    capture(() => new RoutineDispatcher(store, new RoutineScheduler(store, time), time).tick("r3", "local", "g1"));
    capture(() => store.put(base({ id: "r4", timezone: "" })));
    const notifyKey = store.notificationKeys[0] ?? "";
    expect(store.notifyOnce(notifyKey)).toBe(false);
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/13/failure.json"), `${JSON.stringify({ codes, kinds }, null, 2)}\n`);
  });
});
