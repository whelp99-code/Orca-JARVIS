import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { REDACTED } from "../../src/dashboard/contracts.js";
import type { DashboardErrorEnvelope } from "../../src/dashboard/http.js";
import type {
  AgentListResponse,
  OverviewAgent,
  OverviewTask,
  TaskDetailEvent,
  TaskDetailResponse,
  TaskListResponse,
} from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import { TerminalLog } from "./components/terminal-log.js";
import { AgentsPage } from "./pages/agents-page.js";
import { TaskDetailPage } from "./pages/task-detail-page.js";
import { TaskListPage } from "./pages/task-list-page.js";

const AT = "2026-08-18T00:00:00.000Z";
const SECRET = "sk-proj-secret-fixture";

const taskOf = (task_id: string, title: string, updated_at: string, source_ids: readonly string[]): OverviewTask => ({
  task_id,
  title,
  kind: "work",
  state: "running",
  updated_at,
  pending_approval: false,
  source_ids,
});

const eventOf = (sequence: number, title: string): TaskDetailEvent => ({
  event_id: `evt-${String(sequence)}`,
  task_id: "task-1",
  source: "workflow",
  kind: "workflow",
  actor: "jarvis",
  title,
  status: "running",
  payload: {},
  evidence_refs: [],
  created_at: AT,
  sequence,
});

const agent = {
  agent_id: "sha256:deadbeef",
  provider: "codex",
  terminal_id: "terminal-1",
  incarnation_id: "incarnation-1",
  canonical_path: "/tmp/jarvis-dashboard-agent-1/worktree",
  status: "live",
} as const satisfies OverviewAgent;

const populatedTasks = {
  schema_version: 1,
  items: [
    taskOf("task-zeta", "zeta-task", "2026-08-18T00:02:00.000Z", ["run-z"]),
    taskOf("task-alpha", "alpha-task", "2026-08-18T00:01:00.000Z", ["run-a"]),
  ],
} as const satisfies TaskListResponse;

const emptyTasks = { schema_version: 1, items: [] } as const satisfies TaskListResponse;

const populatedDetail = {
  schema_version: 1,
  context: {
    task: taskOf("task-1", "wire argo cli to jaw", AT, ["node-b", "node-a"]),
    events: [eventOf(1, "created"), eventOf(2, "started")],
  },
} as const satisfies TaskDetailResponse;

const populatedAgents = { schema_version: 1, items: [agent] } as const satisfies AgentListResponse;
const emptyAgents = { schema_version: 1, items: [] } as const satisfies AgentListResponse;

const populatedLogs = {
  schema_version: 1,
  agent_id: agent.agent_id,
  status: "running",
  lines: ["safe compile finished in 12.4s", REDACTED],
  truncated: false,
  next_cursor: null,
} as const satisfies TerminalLogResponse;

const logError = {
  schema_version: 1,
  error: { code: "ORCA_UNAVAILABLE", message: "Orca unavailable", request_id: "req-log" },
} as const satisfies DashboardErrorEnvelope;

const retryableError = {
  status: "error",
  kind: "server",
  error: {
    kind: "server",
    code: "ORCA_UNAVAILABLE",
    message: "Unavailable",
    request_id: "req-retry",
  },
} as const;

function texts(name: string): readonly string[] {
  return within(screen.getByRole("region", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("task, agent, and log read pages", () => {
  it("renders task titles in the API list order", () => {
    render(<TaskListPage {...populatedTasks} />);
    expect(screen.getByRole("heading", { name: "작업" })).toBeInTheDocument();
    expect(texts("작업")).toEqual([
      expect.stringContaining("zeta-task"),
      expect.stringContaining("alpha-task"),
    ]);
  });

  it("renders the shipped empty task list state", () => {
    render(<TaskListPage {...emptyTasks} />);
    expect(screen.getByRole("heading", { name: "작업" })).toBeInTheDocument();
    expect(screen.getByText("No tasks")).toBeInTheDocument();
  });

  it("renders the task timeline and graph-equivalent lists in source order", () => {
    render(<TaskDetailPage {...populatedDetail} />);
    expect(screen.getByRole("heading", { name: "wire argo cli to jaw" })).toBeInTheDocument();
    expect(texts("Task timeline")).toEqual([
      expect.stringContaining("created"),
      expect.stringContaining("started"),
    ]);
    const graph = within(screen.getByRole("region", { name: "Task graph" }))
      .getByRole("img", { name: "Task source graph" });
    const graphText = graph.textContent ?? "";
    expect(graphText.indexOf("node-b")).toBeGreaterThanOrEqual(0);
    expect(graphText.indexOf("node-b")).toBeLessThan(graphText.indexOf("node-a"));
  });

  it("renders a live agent by its identity fields", () => {
    render(<AgentsPage {...populatedAgents} />);
    expect(screen.getByRole("heading", { name: "에이전트" })).toBeInTheDocument();
    expect(screen.getByText(agent.provider)).toBeInTheDocument();
    expect(screen.getByText(agent.terminal_id)).toBeInTheDocument();
    expect(screen.getByText(agent.incarnation_id)).toBeInTheDocument();
    expect(screen.getByText(agent.agent_id)).toBeInTheDocument();
  });

  it("renders the shipped empty agent list state", () => {
    render(<AgentsPage {...emptyAgents} />);
    expect(screen.getByRole("heading", { name: "에이전트" })).toBeInTheDocument();
    expect(screen.getByText("No agents connected")).toBeInTheDocument();
  });

  it("renders bounded already-redacted log lines and omits raw secrets", () => {
    render(<TerminalLog {...populatedLogs} />);
    const log = screen.getByRole("log");
    expect(populatedLogs.lines.length).toBeLessThanOrEqual(500);
    expect(log).toHaveTextContent("safe compile finished in 12.4s");
    expect(log).toHaveTextContent(REDACTED);
    expect(log).not.toHaveTextContent(SECRET);
  });

  it("exposes a retry control for a retryable log error", () => {
    let retries = 0;
    render(<TerminalLog error={logError} onRetry={() => { retries += 1; }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retries).toBe(1);
  });

  it("renders populated task titles as encoded detail links", () => {
    render(
      <MemoryRouter>
        <TaskListPage
          {...populatedTasks}
          taskHref={(taskId) => `/tasks/${encodeURIComponent(taskId)}`}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "zeta-task" })).toHaveAttribute(
      "href",
      `/tasks/${encodeURIComponent("task-zeta")}`,
    );
    expect(screen.getByRole("link", { name: "alpha-task" })).toHaveAttribute(
      "href",
      `/tasks/${encodeURIComponent("task-alpha")}`,
    );
  });

  it("renders populated agent identities as detail links", () => {
    render(
      <MemoryRouter>
        <AgentsPage
          {...populatedAgents}
          agentHref={(agentId) => `/agents/${encodeURIComponent(agentId)}`}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: agent.agent_id })).toHaveAttribute(
      "href",
      `/agents/${encodeURIComponent(agent.agent_id)}`,
    );
  });

  it.each([
    {
      name: "작업",
      view: (onRetry: () => void) => <TaskListPage state={retryableError} onRetry={onRetry} />,
    },
    {
      name: "에이전트",
      view: (onRetry: () => void) => <AgentsPage state={retryableError} onRetry={onRetry} />,
    },
  ])("invokes $name onRetry once from a keyboard-operable Retry control", async ({ view }) => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(view(onRetry));
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
