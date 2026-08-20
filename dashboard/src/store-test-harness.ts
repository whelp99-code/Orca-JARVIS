import type {
  AgentListResponse,
  ControlRequestListResponse,
  OverviewAgent,
  OverviewResponse,
  OverviewTask,
  TaskDetailResponse,
  TaskListResponse,
} from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";
import { createDashboardStore } from "./store.js";

const AT = "2026-08-18T00:00:00.000Z";
export const SNAPSHOT_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;
export const RESOURCE_STATUSES = ["idle", "loading", "success", "empty", "error", "retrying"] as const;
export const ERROR_KINDS = ["offline", "forbidden", "not_found", "server"] as const;
type SseType = "snapshot" | "reconcile";
type SsePayload = {
  readonly schema_version: 1;
  readonly type: SseType;
  readonly revision: string;
  readonly topics: readonly string[];
  readonly occurred_at: string;
};
export type Store = ReturnType<typeof createDashboardStore>;
export type Snapshot = ReturnType<Store["getSnapshot"]>;
type Listener = (event: Event) => void;

const agent = {
  agent_id: "sha256:deadbeef",
  provider: "codex",
  terminal_id: "terminal-1",
  incarnation_id: "incarnation-1",
  canonical_path: "/tmp/worktree",
  status: "live",
} as const satisfies OverviewAgent;
const task = (task_id: string): OverviewTask => ({
  task_id,
  title: "wire argo",
  kind: "work",
  state: "running",
  updated_at: AT,
  pending_approval: false,
  source_ids: ["run-1"],
});
const overviewOf = (tasks: readonly OverviewTask[], agents: readonly OverviewAgent[]): OverviewResponse => ({
  schema_version: 1,
  generated_at: AT,
  portfolio: unseenPortfolio,
  cards: [],
  recent_tasks: tasks,
  pending_approvals: [],
  risks: [],
  agents,
});
const listOf = <T>(items: readonly T[]): { readonly schema_version: 1; readonly items: readonly T[] } => ({
  schema_version: 1,
  items,
});
export const populatedOverview = overviewOf([task("task-1")], [agent]);
export const emptyOverview = overviewOf([], []);
const populatedTasks = listOf([task("task-1")]) satisfies TaskListResponse;
export const emptyTasks = listOf([]) satisfies TaskListResponse;
const populatedAgents = listOf([agent]) satisfies AgentListResponse;
export const emptyAgents = listOf([]) satisfies AgentListResponse;
const emptyApprovals = listOf([]) satisfies ControlRequestListResponse;
const taskDetail = {
  schema_version: 1,
  context: { task: task("task-1"), events: [] },
} as const satisfies TaskDetailResponse;
const logs = {
  schema_version: 1,
  agent_id: agent.agent_id,
  status: "running",
  lines: ["ok"],
  truncated: false,
  next_cursor: null,
} as const satisfies TerminalLogResponse;

export class FakeEventSource {
  readonly url: string;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  emit(type: SseType, payload: SsePayload): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }
  }

  fail(): void {
    const event = new Event("error");
    this.onerror?.(event);
    for (const listener of this.listeners.get("error") ?? []) listener(event);
  }
}

export function frame(type: SseType, topics: readonly string[], revision: string): SsePayload {
  return { schema_version: 1, type, revision, topics, occurred_at: AT };
}

export function onceState(store: Store, match: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  return new Promise((resolve) => {
    const current = store.getSnapshot();
    if (match(current)) {
      resolve(current);
      return;
    }
    const unsubscribe = store.subscribe(() => {
      const next = store.getSnapshot();
      if (match(next)) {
        unsubscribe();
        resolve(next);
      }
    });
  });
}

export function dataOf<T>(resource: { readonly status: string; readonly data?: T }): T {
  if ((resource.status !== "success" && resource.status !== "empty") || resource.data === undefined) {
    throw new Error(`missing resource data for ${resource.status}`);
  }
  return resource.data;
}

type ClientData = {
  overview: OverviewResponse;
  tasks: TaskListResponse;
  agents: AgentListResponse;
  approvals: ControlRequestListResponse;
  error: Error | undefined;
  sessionError: Error | undefined;
  hold: boolean;
  release: ((value: OverviewResponse) => void) | undefined;
  failures: {
    tasks: Error | undefined;
    agents: Error | undefined;
    approvals: Error | undefined;
  };
};

function createClient() {
  const calls = {
    session: 0,
    overview: 0,
    tasks: 0,
    agents: 0,
    controlRequests: 0,
    task: 0,
    agentLogs: 0,
  };
  const data: ClientData = {
    overview: populatedOverview,
    tasks: populatedTasks,
    agents: populatedAgents,
    approvals: emptyApprovals,
    error: undefined,
    sessionError: undefined,
    hold: false,
    release: undefined,
    failures: { tasks: undefined, agents: undefined, approvals: undefined },
  };
  return {
    calls,
    data,
    session: async () => {
      calls.session += 1;
      if (data.sessionError !== undefined) throw data.sessionError;
      return { schema_version: 1 as const, csrf_token: "csrf-test-token" };
    },
    overview: async () => {
      calls.overview += 1;
      if (data.error !== undefined) throw data.error;
      if (data.hold) {
        data.hold = false;
        return await new Promise<OverviewResponse>((resolve) => {
          data.release = resolve;
        });
      }
      return data.overview;
    },
    tasks: async () => {
      calls.tasks += 1;
      if (data.failures.tasks !== undefined) throw data.failures.tasks;
      return data.tasks;
    },
    agents: async () => {
      calls.agents += 1;
      if (data.failures.agents !== undefined) throw data.failures.agents;
      return data.agents;
    },
    controlRequests: async () => {
      calls.controlRequests += 1;
      if (data.failures.approvals !== undefined) throw data.failures.approvals;
      return data.approvals;
    },
    task: async (taskId: string) => {
      calls.task += 1;
      return {
        ...taskDetail,
        context: { ...taskDetail.context, task: { ...taskDetail.context.task, task_id: taskId } },
      };
    },
    agentLogs: async () => {
      calls.agentLogs += 1;
      return logs;
    },
  };
}

type Client = ReturnType<typeof createClient>;
export type Harness = {
  readonly store: Store;
  readonly client: Client;
  readonly opened: Promise<FakeEventSource>;
  readonly lifecycle: { sourceCreated: boolean };
};

export function createHarness(): Harness {
  let resolveSource: (source: FakeEventSource) => void = () => undefined;
  const opened = new Promise<FakeEventSource>((resolve) => {
    resolveSource = resolve;
  });
  const client = createClient();
  const lifecycle = { sourceCreated: false };
  const store = createDashboardStore({
    client,
    eventSourceFactory: (url: string) => {
      lifecycle.sourceCreated = true;
      const source = new FakeEventSource(url);
      resolveSource(source);
      return source;
    },
  });
  return { store, client, opened, lifecycle };
}

export async function liveStore(): Promise<Harness & { readonly source: FakeEventSource }> {
  const current = createHarness();
  current.store.start();
  const source = await current.opened;
  const live = onceState(
    current.store,
    (snapshot) => snapshot.connectionState === "live" && snapshot.tasks.status === "success",
  );
  source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
  await live;
  return { ...current, source };
}
