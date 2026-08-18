import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED } from "../../src/dashboard/contracts.js";
import type {
  AgentListResponse,
  ControlRequestListResponse,
  OverviewAgent,
  OverviewResponse,
  OverviewTask,
  TaskDetailEvent,
  TaskDetailResponse,
  TaskListResponse,
} from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import type { DashboardClient } from "./api.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";

const AT = "2026-08-18T00:00:00.000Z";
const SECRET = "sk-proj-secret-fixture";
const LOG_LIMIT = 500;
const AGENT_ID = "sha256:deadbeef";
const SNAPSHOT_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;
type SseType = "snapshot" | "reconcile";
type SsePayload = {
  readonly schema_version: 1; readonly type: SseType; readonly revision: string;
  readonly topics: readonly string[]; readonly occurred_at: string;
};
type Store = ReturnType<typeof createDashboardStore>;
type Snapshot = ReturnType<Store["getSnapshot"]>;
type Listener = (event: Event) => void;
type LogCall = { readonly agentId: string; readonly limit: number | undefined };

const agent = {
  agent_id: AGENT_ID, provider: "codex", terminal_id: "terminal-1",
  incarnation_id: "incarnation-1", canonical_path: "/tmp/worktree", status: "live",
} as const satisfies OverviewAgent;
const taskOf = (task_id: string, title: string, source_ids: readonly string[] = ["run-1"]): OverviewTask => ({
  task_id, title, kind: "work", state: "running", updated_at: AT, pending_approval: false, source_ids,
});
const eventOf = (sequence: number, title: string): TaskDetailEvent => ({
  event_id: `evt-${String(sequence)}`, task_id: "task-1", source: "workflow", kind: "workflow",
  actor: "jarvis", title, status: "running", payload: {}, evidence_refs: [], created_at: AT, sequence,
});
const overview = {
  schema_version: 1, generated_at: AT, cards: [], recent_tasks: [taskOf("task-1", "overview-seed-task")],
  pending_approvals: [], risks: [], agents: [agent],
} as const satisfies OverviewResponse;
const tasks = {
  schema_version: 1, items: [taskOf("task-zeta", "zeta-task"), taskOf("task-alpha", "alpha-task")],
} as const satisfies TaskListResponse;
const agents = { schema_version: 1, items: [agent] } as const satisfies AgentListResponse;
const approvals = { schema_version: 1, items: [] } as const satisfies ControlRequestListResponse;
const taskDetail = {
  schema_version: 1,
  context: {
    task: taskOf("task-1", "wire argo cli to jaw", ["node-b", "node-a"]),
    events: [eventOf(1, "created"), eventOf(2, "started")],
  },
} as const satisfies TaskDetailResponse;
const logs = {
  schema_version: 1, agent_id: AGENT_ID, status: "running",
  lines: ["safe compile finished in 12.4s", REDACTED], truncated: false, next_cursor: null,
} as const satisfies TerminalLogResponse;

class FakeEventSource {
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void { this.closed = true; }
  emit(type: SseType, payload: SsePayload): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }
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

function texts(name: string): readonly string[] {
  return within(screen.getByRole("region", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

function createClient() {
  const counts = { session: 0, overview: 0, tasks: 0, agents: 0, controlRequests: 0, task: 0, agentLogs: 0 };
  const taskIds: string[] = [];
  const logCalls: LogCall[] = [];
  const pending: {
    resolve: ((value: TerminalLogResponse) => void) | undefined;
    taskResolve: ((value: TaskDetailResponse) => void) | undefined;
  } = { resolve: undefined, taskResolve: undefined };
  const client = {
    session: async () => { counts.session += 1; return { schema_version: 1 as const, csrf_token: "csrf-test" }; },
    overview: async () => { counts.overview += 1; return overview; },
    tasks: async () => { counts.tasks += 1; return tasks; },
    agents: async () => { counts.agents += 1; return agents; },
    controlRequests: async () => { counts.controlRequests += 1; return approvals; },
    task: async (taskId: string) => { counts.task += 1; taskIds.push(taskId); return await new Promise<TaskDetailResponse>((resolve) => { pending.taskResolve = resolve; }); },
    agentLogs: async (agentId: string, limit?: number) => {
      counts.agentLogs += 1;
      logCalls.push({ agentId, limit });
      return await new Promise<TerminalLogResponse>((resolve) => { pending.resolve = resolve; });
    },
  } satisfies DashboardClient;
  return { client, counts, taskIds, logCalls, pending };
}

type Harness = {
  readonly store: Store;
  readonly counts: ReturnType<typeof createClient>["counts"];
  readonly taskIds: string[]; readonly logCalls: LogCall[];
  readonly pending: ReturnType<typeof createClient>["pending"];
  readonly opened: Promise<FakeEventSource>;
  readonly lifecycle: { started: number; stopped: number };
  readonly view: ReturnType<typeof render>;
};

function createHarness(initialPath: string): Harness {
  let resolveSource: (source: FakeEventSource) => void = () => undefined;
  const opened = new Promise<FakeEventSource>((resolve) => { resolveSource = resolve; });
  const { client, counts, taskIds, logCalls, pending } = createClient();
  const inner = createDashboardStore({
    client,
    eventSourceFactory: (url: string) => {
      const source = new FakeEventSource(url);
      resolveSource(source);
      return source;
    },
  });
  const lifecycle = { started: 0, stopped: 0 };
  const store: Store = {
    getSnapshot: inner.getSnapshot, subscribe: inner.subscribe, refreshOverview: inner.refreshOverview,
    start() { lifecycle.started += 1; inner.start(); },
    stop() { lifecycle.stopped += 1; inner.stop(); },
  };
  const view = render(<ControlCenterRoot store={store} client={client} initialPath={initialPath} />);
  return { store, counts, taskIds, logCalls, pending, opened, lifecycle, view };
}

let harness: Harness | undefined;
afterEach(() => { cleanup(); harness?.store.stop(); harness = undefined; });

async function liveRoot(initialPath: string): Promise<Harness & { readonly source: FakeEventSource }> {
  const current = createHarness(initialPath);
  harness = current;
  const source = await current.opened;
  const live = onceState(current.store, (snapshot) => snapshot.connectionState === "live");
  await act(async () => {
    source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
    await live;
  });
  return { ...current, source };
}

describe("ControlCenterRoot live routing", () => {
  it("starts the store and renders live overview after a snapshot", async () => {
    const current = await liveRoot("/");
    expect(current.lifecycle.started).toBe(1);
    expect(screen.getByRole("heading", { level: 1, name: "JARVIS Control Center" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.getByText("overview-seed-task")).toBeInTheDocument();
  });

  it("exposes accessible nav and lists tasks in backend order on /tasks", async () => {
    await liveRoot("/tasks");
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    expect(within(nav).getByRole("link", { name: "New proposal" })).toHaveAttribute("href", "/proposals");
    expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
    expect(within(nav).getByRole("link", { name: "Approvals" })).toHaveAttribute("href", "/approvals");
    expect(texts("Tasks")).toEqual([
      expect.stringContaining("zeta-task"),
      expect.stringContaining("alpha-task"),
    ]);
  });

  it("renders the proposal interview on /proposals", async () => {
    await liveRoot("/proposals");
    expect(screen.getByRole("heading", { level: 1, name: "New proposal" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Objective" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("loads a task once and renders summary, timeline, and graph", async () => {
    const current = await liveRoot("/tasks/task-1");
    expect(current.taskIds).toEqual(["task-1"]);
    expect(current.counts.task).toBe(1);
    await act(async () => { current.pending.taskResolve?.(taskDetail); });
    expect(screen.getByRole("heading", { name: "wire argo cli to jaw" })).toBeInTheDocument();
    expect(texts("Timeline")).toEqual([
      expect.stringContaining("created"),
      expect.stringContaining("started"),
    ]);
    expect(texts("Graph")).toEqual([
      expect.stringContaining("node-b"),
      expect.stringContaining("node-a"),
    ]);
  });

  it("renders agent identity then bounded redacted logs on /agents/:agentId", async () => {
    const current = await liveRoot(`/agents/${AGENT_ID}`);
    expect(screen.getByText(agent.provider)).toBeInTheDocument();
    expect(screen.getByText(agent.terminal_id)).toBeInTheDocument();
    expect(screen.getByText(agent.incarnation_id)).toBeInTheDocument();
    expect(screen.getByText(agent.agent_id)).toBeInTheDocument();
    expect(current.logCalls).toEqual([{ agentId: AGENT_ID, limit: LOG_LIMIT }]);
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    await act(async () => { current.pending.resolve?.(logs); });
    const log = screen.getByRole("log");
    expect(log).toHaveTextContent("safe compile finished in 12.4s");
    expect(log).toHaveTextContent(REDACTED);
    expect(log).not.toHaveTextContent(SECRET);
  });

  it("stops the store and ignores late events after unmount", async () => {
    const current = await liveRoot("/");
    const before = { ...current.counts };
    const retained = current.store.getSnapshot();
    current.view.unmount();
    expect(current.lifecycle.stopped).toBe(1);
    expect(current.source.closed).toBe(true);
    current.source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:late"));
    current.source.emit("reconcile", frame("reconcile", ["tasks"], "inst:later"));
    expect(current.counts).toEqual(before);
    expect(current.store.getSnapshot()).toEqual(retained);
  });
});
