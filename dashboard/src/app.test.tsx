import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";

const liveProps = (overview: OverviewResponse): { overview: OverviewResponse } => ({ overview });

const populatedOverview: OverviewResponse = {
  schema_version: 1,
  generated_at: "2026-08-18T00:00:00.000Z",
  cards: [
    { id: "active-work", label: "Active work", value: 1, detail: "1 task in progress" },
    { id: "agents", label: "Agents", value: 1, detail: "1 live binding" },
    { id: "pending-approvals", label: "Pending approvals", value: 1, detail: "1 request awaiting receipt" },
    { id: "risks", label: "Risks", value: 1, detail: "1 open risk" },
  ],
  recent_tasks: [
    {
      task_id: "task-1",
      title: "wire argo cli to jaw",
      kind: "work",
      state: "running",
      updated_at: "2026-08-18T00:00:00.000Z",
      pending_approval: false,
      source_ids: ["run-1"],
    },
  ],
  pending_approvals: [
    {
      request_id: "req-1",
      action: "workflow.start",
      action_level: 2,
      requested_at: "2026-08-18T00:00:00.000Z",
      requested_by: "jarvis-control-center",
      summary: "start workflow for wire argo cli to jaw",
      state: "pending",
    },
  ],
  risks: [{ id: "risk-1", severity: "high", message: "retry may duplicate an external effect" }],
  agents: [
    {
      agent_id: "sha256:deadbeef",
      provider: "codex",
      terminal_id: "terminal-1",
      incarnation_id: "incarnation-1",
      canonical_path: "/tmp/jarvis-dashboard-agent-1/worktree",
      status: "live",
    },
  ],
  portfolio: unseenPortfolio,
};

const emptyOverview: OverviewResponse = {
  schema_version: 1,
  generated_at: "2026-08-18T00:00:00.000Z",
  cards: [],
  recent_tasks: [],
  pending_approvals: [],
  risks: [],
  agents: [],
  portfolio: unseenPortfolio,
};

describe("JARVIS Control Center overview", () => {
  it("renders the full active count even when the recent twenty tasks are completed", () => {
    render(<App overview={{ ...populatedOverview,
      cards: populatedOverview.cards.map(card => card.id === "active-work" ? { ...card, value: 21 } : card),
      recent_tasks: Array.from({ length: 20 }, (_, index) => ({ ...populatedOverview.recent_tasks[0]!,
        task_id: `recent:${index}`, title: `Completed task ${index}`, state: "completed" })),
    }} />);
    expect(within(screen.getByRole("article", { name: "지금 하는 일" })).getByText("21")).toBeInTheDocument();
    expect(screen.getAllByText(/^Completed task /)).toHaveLength(20);
  });
  it("counts only recently connected agents while keeping the other registrations visible", () => {
    render(<App overview={{ ...populatedOverview, agents: ["live", "offline", "stale", "unknown"].map(status => ({
      ...populatedOverview.agents[0]!, agent_id: status, terminal_id: status, status,
    })) }} />);
    expect(within(screen.getByRole("article", { name: "에이전트" })).getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("offline").length).toBeGreaterThan(0);
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
  });
  it("renders the shipped title", () => {
    render(<App {...liveProps(emptyOverview)} />);

    expect(screen.getByRole("heading", { level: 1, name: "JARVIS 현황판" })).toBeInTheDocument();
  });

  it("renders active work, agents, approvals, and risks cards with their counts", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByRole("heading", { level: 2, name: "지금 하는 일" })).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "지금 하는 일" })).getByText("1")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "에이전트" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "승인 대기" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "위험" })).toBeInTheDocument();
  });

  it("renders a seeded recent task, approval, and risk", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByRole("heading", { level: 3, name: "최근 일" })).toBeInTheDocument();
    expect(screen.getByText("wire argo cli to jaw")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 3, name: "승인 대기" })).toBeInTheDocument();
    expect(screen.getByText("workflow.start")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 3, name: "위험" })).toBeInTheDocument();
    expect(screen.getByText("retry may duplicate an external effect")).toBeInTheDocument();
  });

  it("renders a seeded agent by its identity fields", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("terminal-1")).toBeInTheDocument();
  });

  it("shows semantic empty-state copy when overview arrays are empty", () => {
    render(<App {...liveProps(emptyOverview)} />);

    expect(screen.getByText("진행 중인 일 없음")).toBeInTheDocument();
    expect(screen.getByText("연결된 에이전트가 없습니다")).toBeInTheDocument();
    expect(screen.getByText("대기 중인 승인이 없습니다")).toBeInTheDocument();
    expect(screen.getByText("열린 위험이 없습니다")).toBeInTheDocument();
    expect(screen.getByText("최근 기록이 없습니다")).toBeInTheDocument();
  });
});
