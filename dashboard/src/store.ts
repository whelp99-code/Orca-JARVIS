import { createCoalescedRefresh } from "./coalesced-refresh.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import { classifyDashboardError } from "./api.js";
import { PortfolioFreshnessTimer } from "./portfolio-freshness.js";
import { createTaskExecutionResource } from "./task-execution-resource.js";
import { createTaskExecutionOperations } from "./task-execution-operations.js";
import type { PortfolioOverview } from "../../src/dashboard/portfolio-contracts.js";
import type { ConnectionState, DashboardState, DashboardStoreOptions, EventSourceLike, ResourceState } from "./store-types.js";

export type { ConnectionState, DashboardState, DashboardStoreOptions, EventSourceLike, ResourceState };

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
  let connectionVersion = 0;
  let snapshotConnectionVersion = 0;
  let approvalCursor: string | undefined;
  let approvalVersion = 0;
  const freshnessTimer = new PortfolioFreshnessTimer();
  const listeners = new Set<() => void>();
  const executionOperations = createTaskExecutionOperations(value => assign({ taskExecutionOperations: value }));
  const execution = createTaskExecutionResource(value => {
    // Publish fresh authority before releasing delivery guards.
    assign({ taskExecution: value });
    if (!value?.refreshing && (value?.resource.status === "success" || value?.resource.status === "empty")) {
      executionOperations.observe(value.resource.data);
    }
  });

  let reads = createReads(generation);
  let snapshotRefresh = createSnapshotRefresh(generation);

  function createReads(token: number) {
    return {
      overview: createCoalescedRefresh(signal => loadOverview(token, signal)),
      tasks: createCoalescedRefresh(signal => loadTasks(token, signal)),
      agents: createCoalescedRefresh(signal => loadAgents(token, signal)),
      approvals: createCoalescedRefresh(signal => loadApprovals(token, signal)),
    };
  }

  function createSnapshotRefresh(token: number) {
    return createCoalescedRefresh(async () => {
      const version = snapshotConnectionVersion;
      await refetch(token, SNAPSHOT_TOPICS);
      if (token === generation && version === connectionVersion) assign({ connectionState: "live" });
    });
  }

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
    connectionVersion += 1;
    snapshotRefresh.close();
    for (const read of Object.values(reads)) read.close();
    reads = createReads(generation);
    snapshotRefresh = createSnapshotRefresh(generation);
    running = false;
    freshnessTimer.clear();
    source?.close(); source = undefined;
    execution.stop(false);
  }

  async function refreshOverview(): Promise<void> { await refetch(generation, ["overview"]); }
  async function refreshTasks(): Promise<void> {
    const token = generation; assign({ tasks: { status: "retrying" } });
    await refetch(token, ["tasks"]);
  }
  async function refreshAgents(): Promise<void> {
    const token = generation; assign({ agents: { status: "retrying" } });
    await refetch(token, ["agents"]);
  }
  async function refreshApprovals(): Promise<void> {
    const token = generation; assign({ approvals: { status: "retrying" } });
    await refetch(token, ["approvals"]);
  }

  async function firstApprovals(): Promise<void> {
    approvalCursor = undefined;
    await refreshApprovals();
  }

  async function nextApprovals(): Promise<void> {
    if (state.approvals.status !== "success" && state.approvals.status !== "empty") return;
    const cursor = state.approvals.data.page?.next_cursor;
    if (cursor === undefined || cursor === null) return;
    approvalCursor = cursor;
    await refreshApprovals();
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
    await refetch(token, SNAPSHOT_TOPICS);
    if (token !== generation) return;
    const next = options.eventSourceFactory(EVENTS_PATH);
    source = next;
    next.addEventListener("snapshot", (event) => { onFrame(token, "snapshot", event); });
    next.addEventListener("reconcile", (event) => { onFrame(token, "reconcile", event); });
    next.onopen = () => {
      if (token !== generation) return;
      connectionVersion += 1;
      assign({ connectionState: "live" });
    };
    next.onerror = () => {
      if (token !== generation) return;
      connectionVersion += 1;
      assign({ connectionState: "reconnecting" });
    };
  }

  function onFrame(token: number, type: "snapshot" | "reconcile", event: Event): void {
    if (token !== generation) return;
    const topics = parseTopics(event);
    if (topics === undefined) return;
    if (type === "snapshot") {
      snapshotConnectionVersion = connectionVersion;
      void snapshotRefresh.request();
    } else {
      // No Promise.all/awaiter per event: each read owns one shared pending batch.
      requestTopics(token, topics);
    }
  }

  async function refetch(token: number, topics: readonly string[]): Promise<void> {
    await Promise.all(requestTopics(token, topics));
  }

  function requestTopics(token: number, topics: readonly string[]): Promise<void>[] {
    if (token !== generation) return [];
    const wanted = wantedTopics(topics);
    const pending = pendingPatch(wanted);
    if (pending !== undefined) assign(pending);
    const jobs = [execution.reconcile(topics)];
    if (wanted.overview) jobs.push(reads.overview.request());
    if (wanted.tasks) jobs.push(reads.tasks.request());
    if (wanted.agents) jobs.push(reads.agents.request());
    if (wanted.approvals) { approvalVersion++; jobs.push(reads.approvals.request()); }
    return jobs;
  }

  async function loadOverview(token: number, signal: AbortSignal): Promise<void> {
    try {
      const data = await options.client.overview(signal);
      if (token !== generation) return;
      assign({ overview: collectionState(data, isOverviewEmpty) });
      scheduleFreshnessRefresh(token, data.portfolio);
    } catch (error: unknown) { failResource(token, "overview", error); }
  }
  async function loadTasks(token: number, signal: AbortSignal): Promise<void> {
    try {
      const data = await options.client.tasks(signal);
      if (token !== generation) return;
      assign({ tasks: collectionState(data, isListEmpty) });
    } catch (error: unknown) { failResource(token, "tasks", error); }
  }
  async function loadAgents(token: number, signal: AbortSignal): Promise<void> {
    try {
      const data = await options.client.agents(signal);
      if (token !== generation) return;
      assign({ agents: collectionState(data, isListEmpty) });
    } catch (error: unknown) { failResource(token, "agents", error); }
  }
  async function loadApprovals(token: number, signal: AbortSignal): Promise<void> {
    const version = approvalVersion;
    try {
      const data = await options.client.controlRequests(signal, approvalCursor);
      if (token !== generation || version !== approvalVersion) return;
      assign({ approvals: collectionState(data, isListEmpty) });
    } catch (error: unknown) { if (version === approvalVersion) failResource(token, "approvals", error); }
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

  // After every successful overview load, schedule exactly one timer for the earliest next host
  // transition (live → stale at updated_at + 90s, stale → offline at updated_at + 300s). Offline
  // and unseen hosts schedule nothing. A new overview clears and replaces the previous timer, and
  // stop() clears it entirely; generation guards the callback so a stale timer can never fire a
  // refresh for a stopped or restarted store.
  function scheduleFreshnessRefresh(token: number, portfolio: PortfolioOverview): void {
    freshnessTimer.schedule(portfolio, () => {
      if (token !== generation) return;
      void refreshOverview();
    });
  }

  return { getSnapshot, subscribe, start, stop, refreshOverview, refreshTasks, refreshAgents, refreshApprovals,
    firstApprovals, nextApprovals,
    runTaskExecutionOperation: executionOperations.run,
    watchTaskExecution: execution.watch, refreshTaskExecution: execution.refresh };
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
  readonly approvals: boolean;
} {
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
      // The detail page watches canonical task revisions. Discarded detail GETs never updated it.
      if (topic.length > "task:".length) tasks = true;
    }
  }
  return { overview, tasks, agents, approvals };
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
