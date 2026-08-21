import { afterEach, describe, expect, it, vi } from "vitest";
import {
  frame,
  liveStore,
  onceState,
  type Harness,
} from "./store-test-harness.js";

let harness: Harness | undefined;
afterEach(() => {
  harness?.store.stop();
  harness = undefined;
  vi.useRealTimers();
});

describe("dashboard store resource recovery and refresh", () => {
  it.each([
    {
      resource: "tasks" as const,
      refresh: "refreshTasks",
      call: "tasks" as const,
      failure: "tasks" as const,
      recovered: "success" as const,
    },
    {
      resource: "agents" as const,
      refresh: "refreshAgents",
      call: "agents" as const,
      failure: "agents" as const,
      recovered: "success" as const,
    },
    {
      resource: "approvals" as const,
      refresh: "refreshApprovals",
      call: "controlRequests" as const,
      failure: "approvals" as const,
      recovered: "empty" as const,
    },
  ])("recovers an errored $resource resource through public $refresh", async (row) => {
    const current = await liveStore();
    harness = current;
    current.client.data.failures[row.failure] = new Error("server");
    const failed = onceState(current.store, (snapshot) => snapshot[row.resource].status === "error");
    current.source.emit("reconcile", frame("reconcile", [row.resource], "inst:err"));
    await failed;
    current.client.data.failures[row.failure] = undefined;
    const refresh = Reflect.get(current.store, row.refresh);
    expect(typeof refresh).toBe("function");
    const before = current.client.calls[row.call];
    const recovered = onceState(
      current.store,
      (snapshot) => snapshot[row.resource].status === row.recovered,
    );
    if (typeof refresh === "function") void refresh.call(current.store);
    const snapshot = await recovered;
    expect(current.client.calls[row.call]).toBe(before + 1);
    expect(snapshot[row.resource].status).toBe(row.recovered);
  });

  it("refreshes overview exactly when portfolio freshness crosses a threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:30.000Z"));
    const current = await liveStore();
    harness = current;
    current.client.data.overview = {
      ...current.client.data.overview,
      portfolio: {
        hosts: current.client.data.overview.portfolio.hosts.map((host) => ({
          ...host,
          freshness: "live" as const,
          updated_at: "2026-08-20T00:00:00.000Z",
        })) as typeof current.client.data.overview.portfolio.hosts,
        summary: null,
      },
    };
    const beforeRefresh = current.client.calls.overview;
    await current.store.refreshOverview();
    expect(current.client.calls.overview).toBe(beforeRefresh + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(current.client.calls.overview).toBe(beforeRefresh + 1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(current.client.calls.overview).toBe(beforeRefresh + 2);
  });
});
