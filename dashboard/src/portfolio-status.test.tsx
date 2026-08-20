import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PortfolioOverview } from "../../src/dashboard/portfolio-contracts.js";
import { PortfolioStatus } from "./portfolio-status.js";

const unseen: PortfolioOverview = {
  hosts: [
    {
      environment: "local",
      label: "LOCAL",
      freshness: "unseen",
      updated_at: null,
      collector_status: "unseen",
      collector_error: null,
      worktree_count: null,
      terminal_count: null,
      clean_count: null,
      dirty_count: null,
      dirty_path_count: null,
      active_task_count: null,
    },
    {
      environment: "jm-server",
      label: "JM-SERVER",
      freshness: "unseen",
      updated_at: null,
      collector_status: "unseen",
      collector_error: null,
      worktree_count: null,
      terminal_count: null,
      clean_count: null,
      dirty_count: null,
      dirty_path_count: null,
      active_task_count: null,
    },
  ],
  summary: null,
};

const live: PortfolioOverview = {
  hosts: [
    {
      environment: "local",
      label: "LOCAL",
      freshness: "live",
      updated_at: "2026-08-20T00:00:00.000Z",
      collector_status: "ok",
      collector_error: null,
      worktree_count: 4,
      terminal_count: 7,
      clean_count: 3,
      dirty_count: 1,
      dirty_path_count: 2,
      active_task_count: 5,
    },
    {
      environment: "jm-server",
      label: "JM-SERVER",
      freshness: "stale",
      updated_at: "2026-08-20T00:00:00.000Z",
      collector_status: "ok",
      collector_error: null,
      worktree_count: 2,
      terminal_count: 2,
      clean_count: 2,
      dirty_count: 0,
      dirty_path_count: 0,
      active_task_count: 1,
    },
  ],
  summary: {
    github: { issue_count: 11, pull_request_count: 3 },
    milestones: [{ title: "Control center", state: "in_progress" }],
    blockers: [{ title: "Approve live resume", kind: "approval_required" }],
  },
};

describe("Portfolio Status", () => {
  it("renders host counts, updated time, freshness, github, milestones, and blockers", () => {
    render(<PortfolioStatus portfolio={live} />);
    const section = screen.getByRole("region", { name: "Portfolio Status" });
    expect(within(section).getByRole("heading", { name: "LOCAL" })).toBeInTheDocument();
    expect(within(section).getByRole("heading", { name: "JM-SERVER" })).toBeInTheDocument();
    expect(within(section).getByText("live")).toBeInTheDocument();
    expect(within(section).getByText("stale")).toBeInTheDocument();
    expect(section.querySelector("time")?.dateTime).toBe("2026-08-20T00:00:00.000Z");
    expect(within(section).getByText("4")).toBeInTheDocument();
    expect(within(section).getByText("11")).toBeInTheDocument();
    expect(within(section).getByText("Control center")).toBeInTheDocument();
    expect(within(section).getByText("in_progress")).toBeInTheDocument();
    expect(within(section).getByText("Approve live resume")).toBeInTheDocument();
  });

  it("renders unseen and unavailable states when hosts have no snapshot", () => {
    render(<PortfolioStatus portfolio={unseen} />);
    expect(screen.getAllByText("unseen")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });
});
