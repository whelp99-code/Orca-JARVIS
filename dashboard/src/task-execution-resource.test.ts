import { describe, expect, it, vi } from "vitest";
import { createTaskExecutionResource, type TaskExecutionResource } from "./task-execution-resource.js";
import { EMPTY, PENDING } from "./task-execution-test-fixture.js";

describe("watched task execution resource", () => {
  it("ignores older overlapping responses and late responses after leaving a task", async () => {
    let value: TaskExecutionResource | undefined;
    const resource = createTaskExecutionResource(next => { value = next; });
    let first!: (data: typeof EMPTY) => void;
    const loader = vi.fn(async () => EMPTY).mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    resource.watch("task-1", loader);
    loader.mockResolvedValueOnce({ ...EMPTY, requests: [PENDING] });
    await resource.refresh();
    first(EMPTY); await Promise.resolve();
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
