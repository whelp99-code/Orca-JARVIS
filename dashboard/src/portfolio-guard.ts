import type {
  PortfolioBlocker,
  PortfolioHostOverview,
  PortfolioMilestone,
  PortfolioOverview,
  PortfolioSummaryOverview,
} from "../../src/dashboard/portfolio-contracts.js";

const HOST_KEYS = [
  "environment", "label", "freshness", "updated_at", "collector_status", "collector_error",
  "worktree_count", "terminal_count", "clean_count", "dirty_count", "dirty_path_count", "active_task_count",
] as const;

// The backend writes Date.prototype.toISOString(), so a valid updated_at is an exact RFC3339 UTC
// timestamp with millisecond precision. Guarding the shape (not just typeof) protects
// formatTimestamp from rendering an unparseable value.
const RFC3339_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isPortfolioOverview(value: unknown): value is PortfolioOverview {
  if (!isRecord(value) || !exactKeys(value, ["hosts", "summary"]) || !Array.isArray(value.hosts)) return false;
  if (value.hosts.length !== 2) return false;
  const [local, jm] = value.hosts;
  if (!isHost(local) || !isHost(jm)) return false;
  if (local.environment !== "local" || local.label !== "LOCAL") return false;
  if (jm.environment !== "jm-server" || jm.label !== "JM-SERVER") return false;
  return value.summary === null || isSummary(value.summary);
}

function isHost(value: unknown): value is PortfolioHostOverview {
  if (!isRecord(value) || !exactKeys(value, HOST_KEYS)) return false;
  const countKeys = [
    "worktree_count", "terminal_count", "clean_count", "dirty_count", "dirty_path_count", "active_task_count",
  ] as const;
  return (value.environment === "local" || value.environment === "jm-server")
    && (value.label === "LOCAL" || value.label === "JM-SERVER")
    && ["live", "stale", "offline", "unseen"].includes(String(value.freshness))
    && (value.updated_at === null
      || (typeof value.updated_at === "string" && isRfc3339UtcMillis(value.updated_at)))
    && ["ok", "error", "unseen"].includes(String(value.collector_status))
    && (value.collector_error === null || typeof value.collector_error === "string")
    && countKeys.every(key => nullableCount(value[key]));
}

function isSummary(value: unknown): value is PortfolioSummaryOverview {
  if (!isRecord(value) || !exactKeys(value, ["github", "milestones", "blockers"])) return false;
  if (!isRecord(value.github) || !exactKeys(value.github, ["issue_count", "pull_request_count"])) return false;
  return count(value.github.issue_count)
    && count(value.github.pull_request_count)
    && Array.isArray(value.milestones)
    && value.milestones.every(isMilestone)
    && Array.isArray(value.blockers)
    && value.blockers.every(isBlocker);
}

function isMilestone(value: unknown): value is PortfolioMilestone {
  return isRecord(value)
    && exactKeys(value, ["title", "state"])
    && typeof value.title === "string"
    && ["open", "in_progress", "done", "blocked"].includes(String(value.state));
}

function isBlocker(value: unknown): value is PortfolioBlocker {
  return isRecord(value)
    && exactKeys(value, ["title", "kind"])
    && typeof value.title === "string"
    && value.kind === "approval_required";
}

function isRfc3339UtcMillis(value: string): boolean {
  return RFC3339_UTC_MILLIS.test(value) && Number.isFinite(Date.parse(value));
}

function nullableCount(value: unknown): boolean {
  return value === null || count(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
