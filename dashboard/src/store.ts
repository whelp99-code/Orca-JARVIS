import type {
  AgentListResponse,
  ControlRequestListResponse,
  OverviewResponse, TaskListResponse,
} from "../../src/dashboard/read-model.js";
import { classifyDashboardError, type ApiError, type ApiErrorKind, type DashboardClient } from "./api.js";

export type ConnectionState = "live" | "reconnecting" | "offline";
export type ResourceState<T> =
  | { readonly status: "idle" | "loading" | "retrying"; readonly kind?: never }
  | { readonly status: "success"; readonly data: T; readonly kind?: never }
  | { readonly status: "empty"; readonly data: T; readonly kind?: never }
  | { readonly status: "error"; readonly kind: ApiErrorKind; readonly error: ApiError };
export type DashboardState = {
  readonly connectionState: ConnectionState; readonly overview: ResourceState<OverviewResponse>;
  readonly tasks: ResourceState<TaskListResponse>; readonly agents: ResourceState<AgentListResponse>;
  readonly approvals: ResourceState<ControlRequestListResponse>;
};
export type EventSourceLike = {
  addEventListener(type: string, listener: (event: Event) => void): void; close(): void;
  onerror: ((event: Event) => void) | null;
};
export type DashboardStoreOptions = {
  readonly client: DashboardClient; readonly eventSourceFactory: (url: string) => EventSourceLike;
};

const EVENTS_PATH = "/api/v1/events";
const SNAPSHOT_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;
const IDLE = { status: "idle" } as const satisfies ResourceState<never>;

export function createDashboardStore(options: DashboardStoreOptions) {
  let state: DashboardState = {
    connectionState: "offline",
    overview: IDLE,
    tasks: IDLE,
    agents: IDLE,
    approvals: IDLE,
  };
  let generation = 0;
  let running = false;
  let source: EventSourceLike | undefined;
  const listeners = new Set<() => void>();

  function getSnapshot(): DashboardState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }

  function start(): void {
    if (running) return;
    running = true;
    void begin(generation);
  }

  function stop(): void {
    generation += 1;
    running = false;
    source?.close(); source = undefined;
  }

  async function refreshOverview(): Promise<void> { await refetch(generation, ["overview"]); }
  async function refreshTasks(): Promise<void> {
    const token = generation; assign({ tasks: { status: "retrying" } });
    await loadTasks(token);
  }
  async function refreshAgents(): Promise<void> {
    const token = generation; assign({ agents: { status: "retrying" } });
    await loadAgents(token);
  }
  async function refreshApprovals(): Promise<void> {
    const token = generation; assign({ approvals: { status: "retrying" } });
    await loadApprovals(token);
  }

  async function begin(token: number): Promise<void> {
    try {
      await options.client.session();
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (token !== generation) return;
      assign({ connectionState: "offline" });
      return;
    }
    if (token !== generation) return;
    const next = options.eventSourceFactory(EVENTS_PATH);
    source = next;
    next.addEventListener("snapshot", (event) => { void onFrame(token, "snapshot", event); });
    next.addEventListener("reconcile", (event) => { void onFrame(token, "reconcile", event); });
    next.onerror = () => {
      if (token !== generation) return;
      assign({ connectionState: "reconnecting" });
    };
  }

  async function onFrame(token: number, type: "snapshot" | "reconcile", event: Event): Promise<void> {
    if (token !== generation) return;
    const topics = parseTopics(event);
    if (topics === undefined) return;
    switch (type) {
      case "snapshot":
        await refetch(token, SNAPSHOT_TOPICS);
        if (token !== generation) return;
        assign({ connectionState: "live" });
        return;
      case "reconcile":
        await refetch(token, topics);
        return;
      default:
        return assertNever(type);
    }
  }

  async function refetch(token: number, topics: readonly string[]): Promise<void> {
    if (token !== generation) return;
    const wanted = wantedTopics(topics);
    const pending = pendingPatch(wanted);
    if (pending !== undefined) assign(pending);
    const jobs: Array<Promise<void>> = [];
    if (wanted.overview) jobs.push(loadOverview(token));
    if (wanted.tasks) jobs.push(loadTasks(token));
    if (wanted.agents) jobs.push(loadAgents(token));
    if (wanted.approvals) jobs.push(loadApprovals(token));
    for (const taskId of wanted.taskIds) jobs.push(loadTask(token, taskId));
    await Promise.all(jobs);
  }

  async function loadOverview(token: number): Promise<void> {
    try {
      const data = await options.client.overview();
      if (token !== generation) return;
      assign({ overview: collectionState(data, isOverviewEmpty) });
    } catch (error: unknown) { failResource(token, "overview", error); }
  }
  async function loadTasks(token: number): Promise<void> {
    try {
      const data = await options.client.tasks();
      if (token !== generation) return;
      assign({ tasks: collectionState(data, isListEmpty) });
    } catch (error: unknown) { failResource(token, "tasks", error); }
  }
  async function loadAgents(token: number): Promise<void> {
    try {
      const data = await options.client.agents();
      if (token !== generation) return;
      assign({ agents: collectionState(data, isListEmpty) });
    } catch (error: unknown) { failResource(token, "agents", error); }
  }
  async function loadApprovals(token: number): Promise<void> {
    try {
      const data = await options.client.controlRequests();
      if (token !== generation) return;
      assign({ approvals: collectionState(data, isListEmpty) });
    } catch (error: unknown) { failResource(token, "approvals", error); }
  }

  async function loadTask(token: number, taskId: string): Promise<void> {
    try {
      await options.client.task(taskId);
    } catch (error: unknown) {
      if (token !== generation) return;
      if (error instanceof Error) return;
      throw error;
    }
  }

  function failResource(token: number, key: "overview" | "tasks" | "agents" | "approvals", error: unknown): void {
    if (token !== generation) return;
    if (!(error instanceof Error)) throw error;
    const classified = classifyDashboardError(error);
    const failed = { status: "error" as const, kind: classified.kind, error: classified };
    if (key === "overview") assign({ overview: failed });
    else if (key === "tasks") assign({ tasks: failed });
    else if (key === "agents") assign({ agents: failed });
    else assign({ approvals: failed });
  }

  function pendingPatch(wanted: ReturnType<typeof wantedTopics>): Partial<DashboardState> | undefined {
    const overview = wanted.overview ? toPending(state.overview) : undefined;
    const tasks = wanted.tasks ? toPending(state.tasks) : undefined;
    const agents = wanted.agents ? toPending(state.agents) : undefined;
    const approvals = wanted.approvals ? toPending(state.approvals) : undefined;
    if (overview === undefined && tasks === undefined && agents === undefined && approvals === undefined) {
      return undefined;
    }
    return {
      ...(overview === undefined ? {} : { overview }),
      ...(tasks === undefined ? {} : { tasks }),
      ...(agents === undefined ? {} : { agents }),
      ...(approvals === undefined ? {} : { approvals }),
    };
  }

  function assign(partial: Partial<DashboardState>): void {
    state = { ...state, ...partial };
    for (const listener of listeners) listener();
  }

  return { getSnapshot, subscribe, start, stop, refreshOverview, refreshTasks, refreshAgents, refreshApprovals };
}

function toPending<T>(current: ResourceState<T>): ResourceState<T> | undefined {
  switch (current.status) {
    case "idle":
      return { status: "loading" };
    case "error":
      return { status: "retrying" };
    case "loading":
    case "retrying":
    case "success":
    case "empty":
      return undefined;
    default:
      return assertNever(current);
  }
}

function collectionState<T>(data: T, isEmpty: (value: T) => boolean): ResourceState<T> {
  return isEmpty(data) ? { status: "empty", data } : { status: "success", data };
}

function isOverviewEmpty(value: OverviewResponse): boolean {
  return value.recent_tasks.length === 0 && value.pending_approvals.length === 0
    && value.risks.length === 0 && value.agents.length === 0;
}

function isListEmpty(value: { readonly items: readonly unknown[] }): boolean {
  return value.items.length === 0;
}

function wantedTopics(topics: readonly string[]): {
  readonly overview: boolean; readonly tasks: boolean; readonly agents: boolean;
  readonly approvals: boolean; readonly taskIds: readonly string[];
} {
  const taskIds: string[] = [];
  let overview = false;
  let tasks = false;
  let agents = false;
  let approvals = false;
  for (const topic of topics) {
    if (topic === "overview") overview = true;
    else if (topic === "tasks") tasks = true;
    else if (topic === "agents") agents = true;
    else if (topic === "approvals") approvals = true;
    else if (topic.startsWith("task:")) {
      const taskId = topic.slice("task:".length);
      if (taskId.length > 0) taskIds.push(taskId);
    }
  }
  return { overview, tasks, agents, approvals, taskIds };
}

function parseTopics(event: Event): readonly string[] | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.topics)) return undefined;
  if (!value.topics.every((topic) => typeof topic === "string")) return undefined;
  return value.topics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
