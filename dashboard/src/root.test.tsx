import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { DashboardClient } from "./api.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";

const AT = "2026-08-18T00:00:00.000Z";
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

const agent = {
  agent_id: AGENT_ID, provider: "codex", terminal_id: "terminal-1",
  incarnation_id: "incarnation-1", canonical_path: "/tmp/worktree", status: "live",
} as const satisfies OverviewAgent;
const taskOf = (task_id: string, title: string, source_ids: readonly string[] = ["run-1"]): OverviewTask => ({
  task_id, title, kind: "work", state: "running", updated_at: AT, pending_approval: false, source_ids,
});
const overview = {
  schema_version: 1, generated_at: AT, cards: [], recent_tasks: [taskOf("task-1", "overview-seed-task")],
  portfolio: unseenPortfolio, pending_approvals: [], risks: [], agents: [agent],
} as const satisfies OverviewResponse;
const tasks = {
  schema_version: 1, items: [taskOf("task-zeta", "zeta-task"), taskOf("task-alpha", "alpha-task")],
} as const satisfies TaskListResponse;
const agents = { schema_version: 1, items: [agent] } as const satisfies AgentListResponse;
const approvals = {
  schema_version: 1,
  items: [{
    request_id: "request-approval-1", action: "workflow.start", action_level: 2,
    requested_at: AT, requested_by: "jarvis-control-center", summary: "Start workflow", state: "pending",
  }],
} as const satisfies ControlRequestListResponse;

class FakeEventSource {
  closed = false;
  onopen: ((event: Event) => void) | null = null;
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

type ResourceFailure = Partial<Record<"tasks" | "agents" | "approvals", Error>>;

function createClient(failures: ResourceFailure = {}) {
  const counts = { session: 0, overview: 0, tasks: 0, agents: 0, controlRequests: 0, task: 0, agentLogs: 0 };
  const taskIds: string[] = [];
  const pending: {
    resolve: ((value: TerminalLogResponse) => void) | undefined;
    reject: ((reason?: unknown) => void) | undefined;
    taskResolve: ((value: TaskDetailResponse) => void) | undefined;
  } = { resolve: undefined, reject: undefined, taskResolve: undefined };
  const client = {
    session: async () => { counts.session += 1; return { schema_version: 1 as const, csrf_token: "csrf-test" }; },
    overview: async () => { counts.overview += 1; return overview; },
    tasks: async () => {
      counts.tasks += 1;
      if (failures.tasks !== undefined) throw failures.tasks;
      return tasks;
    },
    agents: async () => {
      counts.agents += 1;
      if (failures.agents !== undefined) throw failures.agents;
      return agents;
    },
    controlRequests: async () => {
      counts.controlRequests += 1;
      if (failures.approvals !== undefined) throw failures.approvals;
      return approvals;
    },
    task: async (taskId: string) => { counts.task += 1; taskIds.push(taskId); return await new Promise<TaskDetailResponse>((resolve) => { pending.taskResolve = resolve; }); },
    agentLogs: async () => {
      counts.agentLogs += 1;
      return await new Promise<TerminalLogResponse>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
    },
    workboard: async () => ({ schema_version: 1 as const, generated_at: "2026-08-18T00:00:00.000Z", collected: false, attention: [], groups: [], sources: [] }),
  } satisfies DashboardClient;
  return { client, counts, taskIds, pending };
}

type Harness = {
  readonly store: Store;
  readonly counts: ReturnType<typeof createClient>["counts"];
  readonly taskIds: string[]; readonly pending: ReturnType<typeof createClient>["pending"];
  readonly opened: Promise<FakeEventSource>;
  readonly lifecycle: { started: number; stopped: number };
  readonly view: ReturnType<typeof render>;
  readonly refreshTasks: ReturnType<typeof vi.fn>;
  readonly refreshAgents: ReturnType<typeof vi.fn>;
  readonly refreshApprovals: ReturnType<typeof vi.fn>;
  readonly hydrated: Promise<Snapshot>;
};

function createHarness(initialPath: string, failures: ResourceFailure = {}): Harness {
  let resolveSource: (source: FakeEventSource) => void = () => undefined;
  const opened = new Promise<FakeEventSource>((resolve) => { resolveSource = resolve; });
  const { client, counts, taskIds, pending } = createClient(failures);
  const inner = createDashboardStore({
    client,
    eventSourceFactory: (url: string) => {
      const source = new FakeEventSource(url);
      resolveSource(source);
      return source;
    },
  });
  const lifecycle = { started: 0, stopped: 0 };
  const refreshTasks = vi.fn(async () => undefined);
  const refreshAgents = vi.fn(async () => undefined);
  const refreshApprovals = vi.fn(async () => undefined);
  const hydrated = onceState(inner, (snapshot) => [snapshot.overview, snapshot.tasks, snapshot.agents, snapshot.approvals]
    .every((resource) => resource.status === "success" || resource.status === "empty" || resource.status === "error"));
  const store = {
    getSnapshot: inner.getSnapshot, subscribe: inner.subscribe, refreshOverview: inner.refreshOverview,
    watchTaskExecution: inner.watchTaskExecution, refreshTaskExecution: inner.refreshTaskExecution,
    runTaskExecutionOperation: inner.runTaskExecutionOperation,
    refreshTasks, refreshAgents, refreshApprovals,
    firstApprovals: inner.firstApprovals, nextApprovals: inner.nextApprovals,
    start() { lifecycle.started += 1; inner.start(); },
    stop() { lifecycle.stopped += 1; inner.stop(); },
  };
  const view = render(<ControlCenterRoot store={store} client={client} initialPath={initialPath} />);
  return { store, counts, taskIds, pending, opened, lifecycle, view, refreshTasks, refreshAgents, refreshApprovals, hydrated };
}

let harness: Harness | undefined;
afterEach(() => { cleanup(); harness?.store.stop(); harness = undefined; });

async function liveRoot(
  initialPath: string,
  failures: ResourceFailure = {},
): Promise<Harness & { readonly source: FakeEventSource }> {
  const current = createHarness(initialPath, failures);
  harness = current;
  await act(async () => { await current.hydrated; });
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
    const current = await liveRoot("/overview");
    expect(current.lifecycle.started).toBe(1);
    expect(screen.getByRole("heading", { level: 1, name: "JARVIS 현황판" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "실시간" })).toHaveTextContent("연결됨");
    expect(screen.getByText("overview-seed-task")).toBeInTheDocument();
  });

  it("exposes accessible nav and lists tasks in backend order on /tasks", async () => {
    await liveRoot("/tasks");
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "오늘" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "한눈에" })).toHaveAttribute("href", "/overview");
    expect(within(nav).getByRole("link", { name: "작업" })).toHaveAttribute("href", "/tasks");
    expect(within(nav).getByRole("link", { name: "새 제안" })).toHaveAttribute("href", "/proposals");
    expect(within(nav).getByRole("link", { name: "에이전트" })).toHaveAttribute("href", "/agents");
    expect(within(nav).getByRole("link", { name: "승인" })).toHaveAttribute("href", "/approvals");
    expect(texts("작업")).toEqual([
      expect.stringContaining("zeta-task"),
      expect.stringContaining("alpha-task"),
    ]);
  });

  it("renders the proposal interview on /proposals", async () => {
    await liveRoot("/proposals");
    expect(screen.getByRole("heading", { level: 1, name: "새 제안" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Objective" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });
});
