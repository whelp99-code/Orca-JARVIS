import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

function texts(name: string): readonly string[] {
  return within(screen.getByRole("region", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("task, agent, and log read pages", () => {
  it("renders task titles in the API list order", () => {
    render(<TaskListPage {...populatedTasks} />);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(texts("Tasks")).toEqual([
      expect.stringContaining("zeta-task"),
      expect.stringContaining("alpha-task"),
    ]);
  });

  it("renders the shipped empty task list state", () => {
    render(<TaskListPage {...emptyTasks} />);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("No tasks")).toBeInTheDocument();
  });

  it("renders the task timeline and graph-equivalent lists in source order", () => {
    render(<TaskDetailPage {...populatedDetail} />);
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

  it("renders a live agent by its identity fields", () => {
    render(<AgentsPage {...populatedAgents} />);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByText(agent.provider)).toBeInTheDocument();
    expect(screen.getByText(agent.terminal_id)).toBeInTheDocument();
    expect(screen.getByText(agent.incarnation_id)).toBeInTheDocument();
    expect(screen.getByText(agent.agent_id)).toBeInTheDocument();
  });

  it("renders the shipped empty agent list state", () => {
    render(<AgentsPage {...emptyAgents} />);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
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
});
