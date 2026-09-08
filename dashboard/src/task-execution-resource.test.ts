import { describe, expect, it, vi } from "vitest";
import { createTaskExecutionResource, type TaskExecutionResource } from "./task-execution-resource.js";
import { EMPTY, PENDING } from "./task-execution-test-fixture.js";

describe("watched task execution resource", () => {
  it("coalesces a held task burst without releasing execution guards on an invalidated response", async () => {
    const published: TaskExecutionResource[] = [];
    const resource = createTaskExecutionResource(value => { if (value) published.push(value); });
    const releases: Array<(data: typeof EMPTY) => void> = [];
    const signals: AbortSignal[] = [];
    const leave = resource.watch("task-1", async (_id, signal) => {
      signals.push(signal!);
      return await new Promise(resolve => { releases.push(resolve); });
    });
    for (let i = 0; i < 10_000; i++) void resource.reconcile(["tasks", "approvals", "task:task-1"]);
    const final = resource.refresh();
    expect(releases).toHaveLength(1);
    releases[0]!(EMPTY);
    // The loader continuation and scheduler settlement start the one follow-up.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(releases).toHaveLength(2);
    expect(published.every(value => value.refreshing)).toBe(true);
    releases[1]!({ ...EMPTY, requests: [PENDING] }); await final;
    expect(published.at(-1)).toMatchObject({ refreshing: false, resource: { data: { requests: [PENDING] } } });
    const waiting = resource.refresh();
    expect(signals[2]?.aborted).toBe(false);
    leave(); await waiting;
    expect(signals[2]?.aborted).toBe(true);
    releases[2]!(EMPTY);
  });

  it("ignores older overlapping responses and late responses after leaving a task", async () => {
    let value: TaskExecutionResource | undefined;
    const resource = createTaskExecutionResource(next => { value = next; });
    let first!: (data: typeof EMPTY) => void;
    const loader = vi.fn(async () => EMPTY).mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    resource.watch("task-1", loader);
    loader.mockResolvedValueOnce({ ...EMPTY, requests: [PENDING] });
    const newest = resource.refresh();
    first(EMPTY); await newest;
    expect(value?.resource).toMatchObject({ data: { requests: [PENDING] } });
    let late!: (data: typeof EMPTY) => void;
    const leave = resource.watch("task-2", () => new Promise(resolve => { late = resolve; }));
    leave(); late(EMPTY); await Promise.resolve();
    expect(value).toBeUndefined();
  });

  it("only reconciles active task topics and never publishes after store stop", async () => {
    const publish = vi.fn(); const resource = createTaskExecutionResource(publish);
    const load = vi.fn(async () => EMPTY);
    resource.watch("task-1", load); await resource.refresh();
    load.mockClear();
    await resource.reconcile(["agents", "overview", "task:other"]); expect(load).not.toHaveBeenCalled();
    await resource.reconcile(["task:task-1", "tasks", "approvals"]); expect(load).toHaveBeenCalledTimes(1);
    let done!: (data: typeof EMPTY) => void;
    load.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const waiting = resource.refresh(); resource.stop(false); publish.mockClear(); done(EMPTY); await waiting;
    expect(publish).not.toHaveBeenCalled();
  });
});
