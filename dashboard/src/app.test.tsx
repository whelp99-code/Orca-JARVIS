import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";

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
};

const emptyOverview: OverviewResponse = {
  schema_version: 1,
  generated_at: "2026-08-18T00:00:00.000Z",
  cards: [],
  recent_tasks: [],
  pending_approvals: [],
  risks: [],
  agents: [],
};

describe("JARVIS Control Center overview", () => {
  it("renders the shipped title", () => {
    render(<App {...liveProps(emptyOverview)} />);

    expect(screen.getByRole("heading", { level: 1, name: "JARVIS Control Center" })).toBeInTheDocument();
  });

  it("renders active work, agents, approvals, and risks cards with their counts", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByRole("heading", { level: 2, name: "Active work" })).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Active work" })).getByText("1")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Pending approvals" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Risks" })).toBeInTheDocument();
  });

  it("renders a seeded recent task, approval, and risk", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByRole("heading", { level: 3, name: "Recent" })).toBeInTheDocument();
    expect(screen.getByText("wire argo cli to jaw")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 3, name: "Approvals" })).toBeInTheDocument();
    expect(screen.getByText("workflow.start")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 3, name: "Risks" })).toBeInTheDocument();
    expect(screen.getByText("retry may duplicate an external effect")).toBeInTheDocument();
  });

  it("renders a seeded agent by its identity fields", () => {
    render(<App {...liveProps(populatedOverview)} />);

    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("terminal-1")).toBeInTheDocument();
  });

  it("shows semantic empty-state copy when overview arrays are empty", () => {
    render(<App {...liveProps(emptyOverview)} />);

    expect(screen.getByText("No active work")).toBeInTheDocument();
    expect(screen.getByText("No agents connected")).toBeInTheDocument();
    expect(screen.getByText("No pending approvals")).toBeInTheDocument();
    expect(screen.getByText("No open risks")).toBeInTheDocument();
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
  });
});
