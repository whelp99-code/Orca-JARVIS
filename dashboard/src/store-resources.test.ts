import { afterEach, describe, expect, it } from "vitest";
import {
  ERROR_KINDS,
  RESOURCE_STATUSES,
  createHarness,
  emptyAgents,
  emptyOverview,
  emptyTasks,
  frame,
  onceState,
  populatedOverview,
  type Harness,
} from "./store-test-harness.js";

let harness: Harness | undefined;
afterEach(() => {
  harness?.store.stop();
  harness = undefined;
});

describe("dashboard store resource status transitions", () => {
  it("exposes every resource status through public snapshot and subscribe", async () => {
    const current = createHarness();
    harness = current;
    const seen = new Set<string>();
    const record = (): void => {
      seen.add(current.store.getSnapshot().overview.status);
    };
    record();
    const unsubscribe = current.store.subscribe(record);
    current.client.data.overview = emptyOverview;
    current.client.data.tasks = emptyTasks;
    current.client.data.agents = emptyAgents;
    current.client.data.hold = true;
    const loading = onceState(current.store, (snapshot) => snapshot.overview.status === "loading");
    current.store.start();
    await loading;
    const empty = onceState(current.store, (snapshot) => snapshot.overview.status === "empty");
    current.client.data.release?.(emptyOverview);
    await empty;
    const source = await current.opened;
    current.client.data.overview = populatedOverview;
    const success = onceState(current.store, (snapshot) => snapshot.overview.status === "success");
    source.emit("reconcile", frame("reconcile", ["overview"], "inst:2"));
    await success;
    current.client.data.error = new Error("server");
    const failed = onceState(current.store, (snapshot) => snapshot.overview.status === "error");
    source.emit("reconcile", frame("reconcile", ["overview"], "inst:3"));
    const errorSnapshot = await failed;
    expect(errorSnapshot.overview.status).toBe("error");
    if (errorSnapshot.overview.status === "error") {
      expect(ERROR_KINDS.some((kind) => kind === errorSnapshot.overview.kind)).toBe(true);
    }
    const retrying = onceState(current.store, (snapshot) => snapshot.overview.status === "retrying");
    void current.store.refreshOverview();
    await retrying;
    unsubscribe();
    expect(RESOURCE_STATUSES.every((status) => seen.has(status))).toBe(true);
  });
});
