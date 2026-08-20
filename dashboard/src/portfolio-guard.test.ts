import { describe, expect, it } from "vitest";
import { isPortfolioOverview } from "./portfolio-guard.js";

const host = {
  environment: "local" as const,
  label: "LOCAL" as const,
  freshness: "unseen" as const,
  updated_at: null,
  collector_status: "unseen" as const,
  collector_error: null,
  worktree_count: null,
  terminal_count: null,
  clean_count: null,
  dirty_count: null,
  dirty_path_count: null,
  active_task_count: null,
};

describe("browser portfolio overview guard", () => {
  it("accepts deterministic LOCAL then JM-SERVER entries", () => {
    expect(isPortfolioOverview({
      hosts: [host, { ...host, environment: "jm-server", label: "JM-SERVER" }],
      summary: null,
    })).toBe(true);
  });

  it("rejects missing hosts, reversed order, and extra fields on summary", () => {
    expect(isPortfolioOverview({ hosts: [], summary: null })).toBe(false);
    expect(isPortfolioOverview({
      hosts: [{ ...host, environment: "jm-server", label: "JM-SERVER" }, host],
      summary: null,
    })).toBe(false);
    expect(isPortfolioOverview({ hosts: [host, { ...host, environment: "jm-server", label: "JM-SERVER" }] })).toBe(false);
  });

  it("rejects non-RFC3339 updated timestamps before rendering", () => {
    expect(isPortfolioOverview({
      hosts: [
        { ...host, freshness: "live", updated_at: "not-a-date", collector_status: "ok" },
        { ...host, environment: "jm-server", label: "JM-SERVER", freshness: "live", updated_at: "2026-08-20T00:00:00Z", collector_status: "ok" },
      ],
      summary: null,
    })).toBe(false);
  });
});
