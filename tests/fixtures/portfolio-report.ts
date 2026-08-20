import type {
  PortfolioCollectorErrorV1,
  PortfolioJmReportV1,
  PortfolioLocalReportV1,
} from "../../src/dashboard/portfolio-contracts.js";

export const PORTFOLIO_AT = "2026-08-20T00:00:00.000Z";

export function localReport(overrides: Partial<PortfolioLocalReportV1> = {}): PortfolioLocalReportV1 {
  return {
    schema_version: 1,
    source: "local",
    reported_at: PORTFOLIO_AT,
    host: {
      worktree_count: 4,
      terminal_count: 7,
      clean_count: 3,
      dirty_count: 1,
      dirty_path_count: 2,
      active_task_count: 5,
    },
    github: { issue_count: 11, pull_request_count: 3 },
    milestones: [{ title: "Control center", state: "in_progress" }],
    blockers: [{ title: "Approve live resume", kind: "approval_required" }],
    ...overrides,
  };
}

export function jmReport(overrides: Partial<PortfolioJmReportV1> = {}): PortfolioJmReportV1 {
  return {
    schema_version: 1,
    source: "jm-server",
    reported_at: PORTFOLIO_AT,
    host: {
      worktree_count: 2,
      terminal_count: 2,
      clean_count: 2,
      dirty_count: 0,
      dirty_path_count: 0,
      active_task_count: 1,
    },
    ...overrides,
  };
}

export function collectorError(
  source: "local" | "jm-server" = "local",
  overrides: Partial<PortfolioCollectorErrorV1> = {},
): PortfolioCollectorErrorV1 {
  return {
    schema_version: 1,
    source,
    reported_at: PORTFOLIO_AT,
    collector_status: "error",
    collector_error: "ORCA_UNAVAILABLE",
    ...overrides,
  };
}
