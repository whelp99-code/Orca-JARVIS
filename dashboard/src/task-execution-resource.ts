import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { classifyDashboardError } from "./api.js";
import { createCoalescedRefresh } from "./coalesced-refresh.js";
import type { ResourceState } from "./store-types.js";

export type TaskExecutionResource = Readonly<{ task_id: string; resource: ResourceState<DashboardTaskExecution>; refreshing: boolean }>;
type Selection = {
  taskId: string;
  value: TaskExecutionResource;
  reads: ReturnType<typeof createCoalescedRefresh>;
};

/** One watched task, one running read, and one follow-up. Invalidated reads cannot release action guards. */
export function createTaskExecutionResource(publish: (value: TaskExecutionResource | undefined) => void) {
  let active: Selection | undefined;
  let sequence = 0;

  function stop(clear = true): void {
    sequence++;
    const previous = active;
    active = undefined;
    previous?.reads.close();
    if (previous && clear) publish(undefined);
  }

  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    sequence++;
    const selected = active;
    if (!selected.value.refreshing) {
      selected.value = { ...selected.value, refreshing: true };
      publish(selected.value);
    }
    return selected.reads.request();
  }

  function watch(taskId: string, load: (id: string, signal?: AbortSignal) => Promise<DashboardTaskExecution>) {
    stop(false);
    const selected: Selection = {
      taskId,
      value: { task_id: taskId, refreshing: false, resource: { status: "loading" } },
      reads: createCoalescedRefresh(async signal => {
        const request = sequence;
        try {
          const data = await load(taskId, signal);
          if (selected !== active || request !== sequence) return;
          selected.value = { task_id: taskId, refreshing: false, resource: { status: "success", data } };
        } catch (error: unknown) {
          if (selected !== active || request !== sequence) return;
          const classified = classifyDashboardError(error);
          selected.value = { task_id: taskId, refreshing: false,
            resource: { status: "error", kind: classified.kind, error: classified } };
        }
        publish(selected.value);
      }),
    };
    active = selected;
    void refresh();
    return () => { if (active === selected) stop(); };
  }

  function reconcile(topics: readonly string[]): Promise<void> {
    if (active && topics.some(topic => topic === "tasks" || topic === "approvals" || topic === `task:${active!.taskId}`)) {
      return refresh();
    }
    return Promise.resolve();
  }

  return { watch, refresh, stop, reconcile };
}
