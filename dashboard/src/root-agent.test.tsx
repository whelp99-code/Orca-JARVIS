import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../../src/dashboard/contracts.js";
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
const logs = {
  schema_version: 1, agent_id: AGENT_ID, status: "running",
  lines: ["safe compile finished in 12.4s", REDACTED], truncated: false, next_cursor: null,
} as const satisfies TerminalLogResponse;

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

type ResourceFailure = Partial<Record<"tasks" | "agents" | "approvals", Error>>;

function createClient(failures: ResourceFailure = {}) {
  const counts = { session: 0, overview: 0, tasks: 0, agents: 0, controlRequests: 0, task: 0, agentLogs: 0 };
  const taskIds: string[] = [];
  const logCalls: LogCall[] = [];
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
    agentLogs: async (agentId: string, limit?: number) => {
      counts.agentLogs += 1;
      logCalls.push({ agentId, limit });
      return await new Promise<TerminalLogResponse>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
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
  readonly refreshTasks: ReturnType<typeof vi.fn>;
  readonly refreshAgents: ReturnType<typeof vi.fn>;
  readonly refreshApprovals: ReturnType<typeof vi.fn>;
};

function createHarness(initialPath: string, failures: ResourceFailure = {}): Harness {
  let resolveSource: (source: FakeEventSource) => void = () => undefined;
  const opened = new Promise<FakeEventSource>((resolve) => { resolveSource = resolve; });
  const { client, counts, taskIds, logCalls, pending } = createClient(failures);
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
  const store = {
    getSnapshot: inner.getSnapshot, subscribe: inner.subscribe, refreshOverview: inner.refreshOverview,
    refreshTasks, refreshAgents, refreshApprovals,
    start() { lifecycle.started += 1; inner.start(); },
    stop() { lifecycle.stopped += 1; inner.stop(); },
  };
  const view = render(<ControlCenterRoot store={store} client={client} initialPath={initialPath} />);
  return { store, counts, taskIds, logCalls, pending, opened, lifecycle, view, refreshTasks, refreshAgents, refreshApprovals };
}

let harness: Harness | undefined;
afterEach(() => { cleanup(); harness?.store.stop(); harness = undefined; });

async function liveRoot(
  initialPath: string,
  failures: ResourceFailure = {},
): Promise<Harness & { readonly source: FakeEventSource }> {
  const current = createHarness(initialPath, failures);
  harness = current;
  const hydrated = onceState(current.store, (snapshot) => snapshot.overview.status !== "idle"
    && snapshot.tasks.status !== "idle" && snapshot.agents.status !== "idle"
    && snapshot.approvals.status !== "idle");
  await act(async () => { await hydrated; });
  const source = await current.opened;
  const live = onceState(current.store, (snapshot) => snapshot.connectionState === "live");
  await act(async () => {
    source.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "inst:1"));
    await live;
  });
  return { ...current, source };
}

describe("ControlCenterRoot agent detail", () => {
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

  it("retries rejected agent logs from the terminal Retry control", async () => {
    // Given a live agent-detail route whose first log fetch failed
    const user = userEvent.setup();
    const current = await liveRoot(`/agents/${AGENT_ID}`);
    await act(async () => { current.pending.reject?.(new Error("server")); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(current.logCalls).toEqual([{ agentId: AGENT_ID, limit: LOG_LIMIT }]);

    // When the operator activates Retry
    await user.click(screen.getByRole("button", { name: "Retry" }));

    // Then logs reload once and a resolved retry renders redacted output
    expect(current.logCalls).toEqual([
      { agentId: AGENT_ID, limit: LOG_LIMIT },
      { agentId: AGENT_ID, limit: LOG_LIMIT },
    ]);
    await act(async () => { current.pending.resolve?.(logs); });
    const log = screen.getByRole("log");
    expect(log).toHaveTextContent("safe compile finished in 12.4s");
    expect(log).toHaveTextContent(REDACTED);
    expect(log).not.toHaveTextContent(SECRET);
  });

  it("navigates from an agent identity to the existing agent detail route", async () => {
    const user = userEvent.setup();
    const current = await liveRoot("/agents");
    const agentLink = screen.getByRole("link", { name: AGENT_ID });
    expect(agentLink).toHaveAttribute("href", `/agents/${encodeURIComponent(AGENT_ID)}`);
    await user.click(agentLink);
    expect(current.logCalls).toEqual([{ agentId: AGENT_ID, limit: LOG_LIMIT }]);
  });
});
