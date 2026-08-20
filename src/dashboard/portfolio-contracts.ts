export const PORTFOLIO_MAX_BYTES = 128 * 1024;
export const PORTFOLIO_COUNT_MAX = 1_000_000;
export const PORTFOLIO_LIST_LIMIT = 32;
export const PORTFOLIO_TITLE_LIMIT = 256;
export const PORTFOLIO_ERROR_LIMIT = 512;
export const PORTFOLIO_LIVE_MS = 90_000;
export const PORTFOLIO_STALE_MS = 300_000;
export const PORTFOLIO_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const PORTFOLIO_AUTH_ENVELOPE_KEYS = ["schema_version", "producer", "report", "signature"] as const;

export const PORTFOLIO_ENVIRONMENTS = ["local", "jm-server"] as const;
export const PORTFOLIO_PRODUCERS = {
  local: "jarvis-local",
  "jm-server": "jarvis-jm-server",
} as const;
export const PORTFOLIO_LABELS = {
  local: "LOCAL",
  "jm-server": "JM-SERVER",
} as const;
export const PORTFOLIO_FRESHNESS = ["live", "stale", "offline", "unseen"] as const;
export const MILESTONE_STATES = ["open", "in_progress", "done", "blocked"] as const;
export const HOST_COUNT_KEYS = [
  "worktree_count", "terminal_count", "clean_count", "dirty_count", "dirty_path_count", "active_task_count",
] as const;
export const LOCAL_REPORT_KEYS = [
  "schema_version", "source", "reported_at", "host", "github", "milestones", "blockers",
] as const;
export const JM_REPORT_KEYS = ["schema_version", "source", "reported_at", "host"] as const;
export const ERROR_KEYS = ["schema_version", "source", "reported_at", "collector_status", "collector_error"] as const;
export const GITHUB_KEYS = ["issue_count", "pull_request_count"] as const;
export const MILESTONE_KEYS = ["title", "state"] as const;
export const BLOCKER_KEYS = ["title", "kind"] as const;

export type PortfolioEnvironment = (typeof PORTFOLIO_ENVIRONMENTS)[number];
export type PortfolioProducer = (typeof PORTFOLIO_PRODUCERS)[PortfolioEnvironment];
export type PortfolioFreshness = (typeof PORTFOLIO_FRESHNESS)[number];
export type MilestoneState = (typeof MILESTONE_STATES)[number];
export type Sha256Digest = `sha256:${string}`;

export type PortfolioHostCounts = {
  readonly worktree_count: number;
  readonly terminal_count: number;
  readonly clean_count: number;
  readonly dirty_count: number;
  readonly dirty_path_count: number;
  readonly active_task_count: number;
};

export type PortfolioGithubSummary = {
  readonly issue_count: number;
  readonly pull_request_count: number;
};

export type PortfolioMilestone = {
  readonly title: string;
  readonly state: MilestoneState;
};

export type PortfolioBlocker = {
  readonly title: string;
  readonly kind: "approval_required";
};

export type PortfolioLocalReportV1 = {
  readonly schema_version: 1;
  readonly source: "local";
  readonly reported_at: string;
  readonly host: PortfolioHostCounts;
  readonly github: PortfolioGithubSummary;
  readonly milestones: readonly PortfolioMilestone[];
  readonly blockers: readonly PortfolioBlocker[];
};

export type PortfolioJmReportV1 = {
  readonly schema_version: 1;
  readonly source: "jm-server";
  readonly reported_at: string;
  readonly host: PortfolioHostCounts;
};

export type PortfolioReportV1 = PortfolioLocalReportV1 | PortfolioJmReportV1;

export type PortfolioAuthEnvelopeV1 = {
  readonly schema_version: 1;
  readonly producer: PortfolioProducer;
  readonly report: PortfolioReportV1 | PortfolioCollectorErrorV1;
  readonly signature: `hmac-sha256:${string}`;
};

export type PortfolioAuthPayload = PortfolioReportV1 | PortfolioCollectorErrorV1;

export type PortfolioVerifiedPayload =
  | { readonly kind: "report"; readonly report: PortfolioReportV1 }
  | { readonly kind: "error"; readonly error: PortfolioCollectorErrorV1 };

export type PortfolioCollectorErrorV1 = {
  readonly schema_version: 1;
  readonly source: PortfolioEnvironment;
  readonly reported_at: string;
  readonly collector_status: "error";
  readonly collector_error: string;
};

export type PortfolioIngest =
  | { readonly kind: "report"; readonly report: PortfolioReportV1 }
  | { readonly kind: "error"; readonly error: PortfolioCollectorErrorV1 };

export type PortfolioHostOverview = {
  readonly environment: PortfolioEnvironment;
  readonly label: "LOCAL" | "JM-SERVER";
  readonly freshness: PortfolioFreshness;
  readonly updated_at: string | null;
  readonly collector_status: "ok" | "error" | "unseen";
  readonly collector_error: string | null;
  readonly worktree_count: number | null;
  readonly terminal_count: number | null;
  readonly clean_count: number | null;
  readonly dirty_count: number | null;
  readonly dirty_path_count: number | null;
  readonly active_task_count: number | null;
};

export type PortfolioSummaryOverview = {
  readonly github: PortfolioGithubSummary;
  readonly milestones: readonly PortfolioMilestone[];
  readonly blockers: readonly PortfolioBlocker[];
};

export type PortfolioOverview = {
  readonly hosts: readonly PortfolioHostOverview[];
  readonly summary: PortfolioSummaryOverview | null;
};
