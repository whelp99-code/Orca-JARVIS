import type { PortfolioOverview } from "../../src/dashboard/portfolio-contracts.js";

export const unseenPortfolio: PortfolioOverview = {
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
