import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { isTaskExecutionRejection } from "./task-execution-message.js";

export type TaskExecutionOperation = Readonly<{
  taskId: string; requestId: string; kind: "stage" | "execute";
}>;

/** Delivery bookkeeping, never execution authority. Survives route changes and failed reads. */
export function createTaskExecutionOperations(publish: (items: readonly TaskExecutionOperation[]) => void) {
  let pending: readonly TaskExecutionOperation[] = [];
  function remove(item: TaskExecutionOperation) {
    const next = pending.filter(value => value !== item);
    if (next.length !== pending.length) { pending = next; publish(pending); }
  }
  async function run<T>(item: TaskExecutionOperation, send: () => Promise<T>): Promise<T> {
    if (pending.some(value => value.taskId === item.taskId && (value.kind === "stage" || item.kind === "stage"
      || value.requestId === item.requestId))) throw new TypeError("Task request delivery is unresolved");
    // Never evict an unresolved operation to make room for another send.
    if (pending.length >= 128) throw new TypeError("Unresolved task delivery limit reached");
    pending = [...pending, item]; publish(pending);
    try { return await send(); }
    catch (error) { if (isTaskExecutionRejection(error)) remove(item); throw error; }
    // A successful HTTP response alone does not refresh the displayed authority state.
  }
  function observe(data: DashboardTaskExecution) {
    for (const item of pending) {
      if (item.taskId !== data.task_id) continue;
      const request = data.requests.find(value => value.request.request_id === item.requestId);
      if (request && (item.kind === "stage" || !["pending", "approved"].includes(request.request.state))) remove(item);
    }
  }
  return { run, observe };
}
