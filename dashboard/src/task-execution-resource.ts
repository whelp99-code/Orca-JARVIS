import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { classifyDashboardError } from "./api.js";
import type { ResourceState } from "./store-types.js";

export type TaskExecutionResource = Readonly<{ task_id: string; resource: ResourceState<DashboardTaskExecution>; refreshing: boolean }>;

/** One watched task in the dashboard store. Sequence fences prevent late responses from replacing a newer read. */
export function createTaskExecutionResource(publish: (value: TaskExecutionResource | undefined) => void) {
  let active: { taskId: string; load: (id: string) => Promise<DashboardTaskExecution>; value: TaskExecutionResource } | undefined;
  let sequence = 0;
  const stop = (clear = true) => { sequence++; const previous = active; active = undefined; if (previous && clear) publish(undefined); };
  async function refresh() {
    if (!active) return;
    const selected = active; const request = ++sequence;
    selected.value = { ...selected.value, refreshing: true };
    publish(selected.value);
    try {
      const data = await selected.load(selected.taskId);
      if (selected !== active || request !== sequence) return;
      selected.value = { task_id: selected.taskId, refreshing: false, resource: { status: "success", data } };
    } catch (error) {
      if (selected !== active || request !== sequence) return;
      const classified = classifyDashboardError(error);
      selected.value = { task_id: selected.taskId, refreshing: false,
        resource: { status: "error", kind: classified.kind, error: classified } };
    }
    publish(selected.value);
  }
  function watch(taskId: string, load: (id: string) => Promise<DashboardTaskExecution>) {
    sequence++;
    const selected = { taskId, load, value: { task_id: taskId, refreshing: false,
      resource: { status: "loading" as const } } as TaskExecutionResource };
    active = selected; void refresh();
    return () => { if (active === selected) stop(); };
  }
  async function reconcile(topics: readonly string[]) {
    if (active && topics.some(topic => ["tasks", "approvals", `task:${active!.taskId}`].includes(topic))) await refresh();
  }
  return { watch, refresh, stop, reconcile };
}
