import { afterEach, describe, expect, it } from "vitest";
import type { AgentListResponse, ControlRequestListResponse, OverviewAgent, OverviewResponse, OverviewTask, TaskDetailResponse, TaskListResponse } from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import { createDashboardStore } from "./store.js";

const AT = "2026-08-18T00:00:00.000Z";
const SNAPSHOT_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;
const RESOURCE_STATUSES = ["idle", "loading", "success", "empty", "error", "retrying"] as const;
const ERROR_KINDS = ["offline", "forbidden", "not_found", "server"] as const;
type SseType = "snapshot" | "reconcile";
type SsePayload = {
  readonly schema_version: 1; readonly type: SseType; readonly revision: string;
  readonly topics: readonly string[]; readonly occurred_at: string;
};
type Store = ReturnType<typeof createDashboardStore>;
type Snapshot = ReturnType<Store["getSnapshot"]>;
type Listener = (event: Event) => void;

const agent = {
  agent_id: "sha256:deadbeef", provider: "codex", terminal_id: "terminal-1",
  incarnation_id: "incarnation-1", canonical_path: "/tmp/worktree", status: "live",
} as const satisfies OverviewAgent;
const task = (task_id: string): OverviewTask => ({
  task_id, title: "wire argo", kind: "work", state: "running", updated_at: AT, pending_approval: false, source_ids: ["run-1"],
});
const overviewOf = (tasks: readonly OverviewTask[], agents: readonly OverviewAgent[]): OverviewResponse => ({
  schema_version: 1, generated_at: AT, cards: [], recent_tasks: tasks, pending_approvals: [], risks: [], agents,
});
const listOf = <T>(items: readonly T[]): { readonly schema_version: 1; readonly items: readonly T[] } => ({ schema_version: 1, items });
const populatedOverview = overviewOf([task("task-1")], [agent]);
const emptyOverview = overviewOf([], []);
const populatedTasks = listOf([task("task-1")]) satisfies TaskListResponse;
const emptyTasks = listOf([]) satisfies TaskListResponse;
const populatedAgents = listOf([agent]) satisfies AgentListResponse;
const emptyAgents = listOf([]) satisfies AgentListResponse;
const emptyApprovals = listOf([]) satisfies ControlRequestListResponse;
const taskDetail = { schema_version: 1, context: { task: task("task-1"), events: [] } } as const satisfies TaskDetailResponse;
const logs = { schema_version: 1, agent_id: agent.agent_id, status: "running", lines: ["ok"], truncated: false, next_cursor: null } as const satisfies TerminalLogResponse;

class FakeEventSource {
  readonly url: string;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  close(): void { this.closed = true; }
  emit(type: SseType, payload: SsePayload): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
  fail(): void {
    const event = new Event("error");
    this.onerror?.(event);
    for (const listener of this.listeners.get("error") ?? []) listener(event);
  }
}

function frame(type: SseType, topics: readonly string[], revision: string): SsePayload {
  return { schema_version: 1, type, revision, topics, occurred_at: AT };
}

function onceState(store: Store, match: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  return new Promise((resolve) => {
    const current = store.getSnapshot();
    if (match(current)) { resolve(current); return; }
    const unsubscribe = store.subscribe(() => {
      const next = store.getSnapshot();
      if (match(next)) { unsubscribe(); resolve(next); }
    });
  });
}

function dataOf<T>(resource: { readonly status: string; readonly data?: T }): T {
  if ((resource.status !== "success" && resource.status !== "empty") || resource.data === undefined) {
    throw new Error(`missing resource data for ${resource.status}`);
  }
  return resource.data;
}

type ClientData = {
  overview: OverviewResponse; tasks: TaskListResponse; agents: AgentListResponse;
  approvals: ControlRequestListResponse; error: Error | undefined; hold: boolean;
  release: ((value: OverviewResponse) => void) | undefined;
};

function createClient() {
  const calls = { session: 0, overview: 0, tasks: 0, agents: 0, controlRequests: 0, task: 0, agentLogs: 0 };
  const data: ClientData = {
    overview: populatedOverview, tasks: populatedTasks, agents: populatedAgents,
    approvals: emptyApprovals, error: undefined, hold: false, release: undefined,
  };
  return {
    calls, data,
    session: async () => { calls.session += 1; return { schema_version: 1 as const, csrf_token: "csrf-test-token" }; },
    overview: async () => {
      calls.overview += 1;
      if (data.error !== undefined) throw data.error;
      if (data.hold) {
        data.hold = false;
        return await new Promise<OverviewResponse>((resolve) => { data.release = resolve; });
      }
      return data.overview;
    },
    tasks: async () => { calls.tasks += 1; return data.tasks; },
    agents: async () => { calls.agents += 1; return data.agents; },
    controlRequests: async () => { calls.controlRequests += 1; return data.approvals; },
    task: async (taskId: string) => {
      calls.task += 1;
      return { ...taskDetail, context: { ...taskDetail.context, task: { ...taskDetail.context.task, task_id: taskId } } };
    },
    agentLogs: async () => { calls.agentLogs += 1; return logs; },
  };
}

type Client = ReturnType<typeof createClient>;
type Harness = { readonly store: Store; readonly client: Client; readonly opened: Promise<FakeEventSource> };

function createHarness(): Harness {
  let resolveSource: (source: FakeEventSource) => void = () => undefined;
  const opened = new Promise<FakeEventSource>((resolve) => { resolveSource = resolve; });
  const client = createClient();
  const store = createDashboardStore({
    client,
    eventSourceFactory: (url: string) => {
      const source = new FakeEventSource(url);
      resolveSource(source);
      return source;
    },
  });
  return { store, client, opened };
}

let harness: Harness | undefined;
afterEach(() => { harness?.store.stop(); harness = undefined; });

async function liveStore(): Promise<Harness & { readonly source: FakeEventSource }> {
  const current = createHarness();
  harness = current;
  current.store.start();
  const source = await current.opened;
  const live = onceState(current.store, (snapshot) => snapshot.connectionState === "live" && snapshot.tasks.status === "success");
  source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
  await live;
  return { ...current, source };
}

describe("dashboard store SSE refetch", () => {
  it("opens SSE on start and refetches snapshot topics after the snapshot event", async () => {
    const current = createHarness();
    harness = current;
    current.store.start();
    const source = await current.opened;
    expect(source.url).toBe("/api/v1/events");
    const live = onceState(current.store, (snapshot) =>
      snapshot.connectionState === "live" && snapshot.overview.status === "success"
      && snapshot.tasks.status === "success" && snapshot.agents.status === "success"
      && snapshot.approvals.status === "empty");
    source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
    const snapshot = await live;
    expect(current.client.calls).toMatchObject({ overview: 1, tasks: 1, agents: 1, controlRequests: 1 });
    expect(dataOf(snapshot.tasks).items.map((item) => item.task_id)).toEqual(["task-1"]);
  });

  it("refetches only the named canonical topics on reconcile", async () => {
    const current = await liveStore();
    const before = { ...current.client.calls };
    const refreshed = onceState(current.store, () =>
      current.client.calls.tasks === before.tasks + 1 && current.client.calls.task === before.task + 1);
    current.source.emit("reconcile", frame("reconcile", ["tasks", "task:task-1"], "inst:2"));
    await refreshed;
    expect(current.client.calls.overview).toBe(before.overview);
    expect(current.client.calls.agents).toBe(before.agents);
    expect(current.client.calls.controlRequests).toBe(before.controlRequests);
    expect(current.client.calls.agentLogs).toBe(before.agentLogs);
  });

  it("marks reconnecting on SSE error while retaining last canonical data", async () => {
    const current = await liveStore();
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
    const before = { ...current.client.calls };
    const replaced = onceState(current.store, () =>
      current.client.calls.overview === before.overview + 1 && current.client.calls.tasks === before.tasks + 1
      && current.client.calls.agents === before.agents + 1 && current.client.calls.controlRequests === before.controlRequests + 1);
    current.source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:3"));
    const snapshot = await replaced;
    expect(dataOf(snapshot.tasks).items).toHaveLength(1);
    expect(dataOf(snapshot.overview).recent_tasks).toHaveLength(1);
    expect(current.client.calls).toMatchObject({
      overview: before.overview + 1, tasks: before.tasks + 1, agents: before.agents + 1,
      controlRequests: before.controlRequests + 1, task: before.task, agentLogs: before.agentLogs,
    });
  });

  it("closes EventSource on stop and ignores late snapshot and reconcile events", async () => {
    const current = await liveStore();
    const before = { ...current.client.calls };
    const retained = current.store.getSnapshot();
    let notified = false;
    const unsubscribe = current.store.subscribe(() => { notified = true; });
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

  it("exposes every resource status through public snapshot and subscribe", async () => {
    const current = createHarness();
    harness = current;
    const seen = new Set<string>();
    const record = (): void => { seen.add(current.store.getSnapshot().overview.status); };
    record();
    const unsubscribe = current.store.subscribe(record);
    current.client.data.overview = emptyOverview;
    current.client.data.tasks = emptyTasks;
    current.client.data.agents = emptyAgents;
    current.client.data.hold = true;
    current.store.start();
    const source = await current.opened;
    const loading = onceState(current.store, (snapshot) => snapshot.overview.status === "loading");
    source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
    await loading;
    const empty = onceState(current.store, (snapshot) => snapshot.overview.status === "empty");
    current.client.data.release?.(emptyOverview);
    await empty;
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
