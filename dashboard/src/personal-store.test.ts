import { describe, expect, it } from "vitest";
import type { PersonalClient, TodayResponse } from "./personal-api.js";
import { createPersonalStore } from "./personal-store.js";

const today = { schema_version: 1, resource: "today", generated_at: "2026-08-28T12:10:00.000Z", state: "ready",
  brief: { state: "ready", brief_id: null, generated_at: null, item_count: 0 }, active_decision_count: 0,
  notification_summary: { total: 0, states: [] }, current_daily_run: null, last_daily_run: null, latest_verified_closeout: null,
  next_actions: [], conflicts: [], omissions: [],
  freshness: { state: "fresh", checked_at: "2026-08-28T12:00:00.000Z", fresh_until: "2026-08-28T13:00:00.000Z" },
  deep_links: { decisions: "/api/v1/decision-inbox", daily_runs: "/api/v1/daily-runs", notifications: "/api/v1/notification-intents", source_health: "/api/v1/source-health" } } as const satisfies TodayResponse;
const page = { schema_version: 1 as const, generated_at: today.generated_at, state: "no_data" as const, items: [] };

type Listener = (event: Event) => void;
class Source {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, Listener>();
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, listener); }
  close(): void {}
  emit(type: string, topics: readonly string[]): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify({ schema_version: 1, type, revision: "r:1", topics, occurred_at: today.generated_at }) }));
  }
}

function client(todayLoader: () => Promise<TodayResponse>): PersonalClient {
  return { today: todayLoader, decisions: async () => page, notifications: async () => page, health: async () => page,
    recommendation: async () => { throw new Error("unused"); }, evidence: async () => { throw new Error("unused"); },
    accept: async () => { throw new Error("unused"); } };
}

function settled(store: ReturnType<typeof createPersonalStore>): Promise<void> {
  return new Promise((resolve) => { const stop = store.subscribe(() => { if (store.getSnapshot().status !== "loading") { stop(); resolve(); } }); });
}

describe("Task31 personal resource store", () => {
  it("subscribes before hydration and refetches personal topics", async () => {
    // Given: a source factory and observable load ordering.
    const order: string[] = []; const source = new Source(); let calls = 0;
    const store = createPersonalStore({ client: client(async () => { calls += 1; order.push("load"); return today; }),
      eventSourceFactory: () => { order.push("subscribe"); return source; } });

    // When: hydration and a personal invalidation settle.
    const first = settled(store); store.start(); await first;
    const second = settled(store); source.emit("reconcile", ["personal.today.v1"]); await second;

    // Then: registration wins the race and Linux is read twice.
    expect(order.slice(0, 2)).toEqual(["subscribe", "load"]);
    expect(calls).toBe(2);
    expect(store.getSnapshot().status).toBe("success");
    store.stop();
  });

  it("prevents an older overlapping load from replacing the newest SSE settlement", async () => {
    // Given: hydration is held while a newer personal invalidation starts another load.
    const source = new Source();
    const releases: Array<(value: TodayResponse) => void> = [];
    const store = createPersonalStore({
      client: client(async () => await new Promise<TodayResponse>((resolve) => { releases.push(resolve); })),
      eventSourceFactory: () => source,
    });
    store.start();
    source.emit("reconcile", ["personal.today.v1"]);
    expect(releases).toHaveLength(2);
    const newest = { ...today, generated_at: "2026-08-28T12:20:00.000Z" };

    // When: the newer load settles before the older hydration response.
    const current = settled(store);
    releases[1]?.(newest);
    await current;
    releases[0]?.(today);
    await Promise.resolve();

    // Then: the older bytes cannot restore stale authority.
    expect(store.getSnapshot()).toMatchObject({ status: "success", data: { today: newest } });
    store.stop();
  });

  it("keeps cached data stale and mutation-disabled after disconnect", async () => {
    // Given: a hydrated personal store.
    const source = new Source(); const store = createPersonalStore({ client: client(async () => today), eventSourceFactory: () => source });
    const ready = settled(store); store.start(); await ready; source.onopen?.(new Event("open"));

    // When: SSE disconnects.
    source.onerror?.(new Event("error"));

    // Then: cached data is visible but never authoritative for action.
    expect(store.getSnapshot()).toMatchObject({ status: "stale", connectionState: "reconnecting", data: { today } });
    store.stop();
  });
});
