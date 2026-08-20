import { afterEach, describe, expect, it } from "vitest";
import {
  SNAPSHOT_TOPICS,
  createHarness,
  dataOf,
  frame,
  liveStore,
  onceState,
  type Harness,
  type Snapshot,
} from "./store-test-harness.js";

let harness: Harness | undefined;
afterEach(() => {
  harness?.store.stop();
  harness = undefined;
});

describe("dashboard store SSE refetch", () => {
  it("hydrates canonical resources before opening EventSource", async () => {
    const current = createHarness();
    harness = current;
    current.client.data.hold = true;
    const loading = onceState(current.store, (snapshot) => snapshot.overview.status === "loading");
    current.store.start();
    await loading;
    expect(current.lifecycle.sourceCreated).toBe(false);
    current.client.data.release?.(current.client.data.overview);
    await current.opened;
    expect(current.lifecycle.sourceCreated).toBe(true);
  });

  it("hydrates canonical resources and marks live when the initial snapshot is missed", async () => {
    const current = createHarness();
    harness = current;
    current.store.start();
    const source = await current.opened;
    expect(current.client.calls).toMatchObject({
      overview: 1,
      tasks: 1,
      agents: 1,
      controlRequests: 1,
    });
    source.open();
    expect(current.store.getSnapshot().connectionState).toBe("live");
  });

  it("settles offline when the initial session request fails", async () => {
    const current = createHarness();
    harness = current;
    current.client.data.sessionError = new TypeError("Failed to fetch");
    const settled = new Promise<Snapshot>((resolve) => {
      const unsubscribe = current.store.subscribe(() => {
        unsubscribe();
        resolve(current.store.getSnapshot());
      });
    });
    current.store.start();
    const snapshot = await settled;
    expect(snapshot.connectionState).toBe("offline");
    expect(current.client.calls).toMatchObject({
      session: 1,
      overview: 0,
      tasks: 0,
      agents: 0,
      controlRequests: 0,
    });
  });

  it("opens SSE on start and refetches snapshot topics after the snapshot event", async () => {
    const current = createHarness();
    harness = current;
    current.store.start();
    const source = await current.opened;
    const before = { ...current.client.calls };
    expect(source.url).toBe("/api/v1/events");
    const live = onceState(
      current.store,
      (snapshot) => snapshot.connectionState === "live"
        && snapshot.overview.status === "success"
        && snapshot.tasks.status === "success"
        && snapshot.agents.status === "success"
        && snapshot.approvals.status === "empty",
    );
    source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
    const snapshot = await live;
    expect(current.client.calls).toMatchObject({
      overview: before.overview + 1,
      tasks: before.tasks + 1,
      agents: before.agents + 1,
      controlRequests: before.controlRequests + 1,
    });
    expect(dataOf(snapshot.tasks).items.map((item) => item.task_id)).toEqual(["task-1"]);
  });

  it("refetches only the named canonical topics on reconcile", async () => {
    const current = await liveStore();
    harness = current;
    const before = { ...current.client.calls };
    const refreshed = onceState(
      current.store,
      () => current.client.calls.tasks === before.tasks + 1 && current.client.calls.task === before.task + 1,
    );
    current.source.emit("reconcile", frame("reconcile", ["tasks", "task:task-1"], "inst:2"));
    await refreshed;
    expect(current.client.calls.overview).toBe(before.overview);
    expect(current.client.calls.agents).toBe(before.agents);
    expect(current.client.calls.controlRequests).toBe(before.controlRequests);
    expect(current.client.calls.agentLogs).toBe(before.agentLogs);
  });

  it("marks reconnecting on SSE error while retaining last canonical data", async () => {
    const current = await liveStore();
    harness = current;
    const retained = dataOf(current.store.getSnapshot().tasks).items;
    const reconnecting = onceState(current.store, (snapshot) => snapshot.connectionState === "reconnecting");
    current.source.fail();
    const snapshot = await reconnecting;
    expect(snapshot.connectionState).toBe("reconnecting");
    expect(dataOf(snapshot.tasks).items).toEqual(retained);
    expect(dataOf(snapshot.overview).recent_tasks).toHaveLength(1);
  });

  it("replaces canonical collections on a second snapshot without duplicating mutation calls", async () => {
    const current = await liveStore();
    harness = current;
    const before = { ...current.client.calls };
    const replaced = onceState(
      current.store,
      () => current.client.calls.overview === before.overview + 1
        && current.client.calls.tasks === before.tasks + 1
        && current.client.calls.agents === before.agents + 1
        && current.client.calls.controlRequests === before.controlRequests + 1,
    );
    current.source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:3"));
    const snapshot = await replaced;
    expect(dataOf(snapshot.tasks).items).toHaveLength(1);
    expect(dataOf(snapshot.overview).recent_tasks).toHaveLength(1);
    expect(current.client.calls).toMatchObject({
      overview: before.overview + 1,
      tasks: before.tasks + 1,
      agents: before.agents + 1,
      controlRequests: before.controlRequests + 1,
      task: before.task,
      agentLogs: before.agentLogs,
    });
  });

  it("closes EventSource on stop and ignores late snapshot and reconcile events", async () => {
    const current = await liveStore();
    harness = current;
    const before = { ...current.client.calls };
    const retained = current.store.getSnapshot();
    let notified = false;
    const unsubscribe = current.store.subscribe(() => {
      notified = true;
    });
    current.store.stop();
    expect(current.source.closed).toBe(true);
    current.source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:4"));
    current.source.emit("reconcile", frame("reconcile", ["tasks"], "inst:5"));
    current.source.fail();
    unsubscribe();
    expect(notified).toBe(false);
    expect(current.client.calls).toEqual(before);
    expect(current.store.getSnapshot()).toEqual(retained);
  });
});
