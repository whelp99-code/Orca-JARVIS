import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../db.js";
import { RFC3339_MS_PATTERN, SECRET_KEY_PATTERN, TERMINAL_SECRET_PATTERN } from "./contracts.js";
import {
  BLOCKER_KEYS,
  ERROR_KEYS,
  GITHUB_KEYS,
  HOST_COUNT_KEYS,
  JM_REPORT_KEYS,
  LOCAL_REPORT_KEYS,
  MILESTONE_KEYS,
  MILESTONE_STATES,
  PORTFOLIO_COUNT_MAX,
  PORTFOLIO_ENVIRONMENTS,
  PORTFOLIO_ERROR_LIMIT,
  PORTFOLIO_LIST_LIMIT,
  PORTFOLIO_MAX_BYTES,
  PORTFOLIO_TITLE_LIMIT,
  type PortfolioBlocker,
  type PortfolioCollectorErrorV1,
  type PortfolioEnvironment,
  type PortfolioGithubSummary,
  type PortfolioHostCounts,
  type PortfolioIngest,
  type PortfolioJmReportV1,
  type PortfolioLocalReportV1,
  type PortfolioMilestone,
  type Sha256Digest,
} from "./portfolio-contracts.js";

type Fail = () => never;

const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{8,}/;

const fail: Fail = () => {
  throw new JarvisError("PORTFOLIO_INPUT_INVALID");
};

export function parsePortfolioIngest(input: Buffer): PortfolioIngest {
  if (input.byteLength < 1 || input.byteLength > PORTFOLIO_MAX_BYTES) fail();
  let value: unknown;
  try {
    value = JSON.parse(input.toString("utf8"));
  } catch {
    fail();
  }
  rejectSecrets(value);
  const record = asRecord(value);
  if (record.collector_status !== undefined) return { kind: "error", error: parseError(record) };
  const source = parseSource(record.source);
  if (source === "local") return { kind: "report", report: parseLocal(record) };
  return { kind: "report", report: parseJm(record) };
}

export function digestPortfolioValue(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function parseLocal(value: Record<string, unknown>): PortfolioLocalReportV1 {
  exactKeys(value, LOCAL_REPORT_KEYS);
  if (value.schema_version !== 1 || parseSource(value.source) !== "local") fail();
  return {
    schema_version: 1,
    source: "local",
    reported_at: parseTimestamp(value.reported_at),
    host: parseHost(value.host),
    github: parseGithub(value.github),
    milestones: parseMilestones(value.milestones),
    blockers: parseBlockers(value.blockers),
  };
}

function parseJm(value: Record<string, unknown>): PortfolioJmReportV1 {
  exactKeys(value, JM_REPORT_KEYS);
  if (value.schema_version !== 1 || parseSource(value.source) !== "jm-server") fail();
  return {
    schema_version: 1,
    source: "jm-server",
    reported_at: parseTimestamp(value.reported_at),
    host: parseHost(value.host),
  };
}

function parseError(value: Record<string, unknown>): PortfolioCollectorErrorV1 {
  exactKeys(value, ERROR_KEYS);
  if (value.schema_version !== 1 || value.collector_status !== "error") fail();
  return {
    schema_version: 1,
    source: parseSource(value.source),
    reported_at: parseTimestamp(value.reported_at),
    collector_status: "error",
    collector_error: boundedString(value.collector_error, PORTFOLIO_ERROR_LIMIT),
  };
}

function parseHost(value: unknown): PortfolioHostCounts {
  const record = asRecord(value);
  exactKeys(record, HOST_COUNT_KEYS);
  return {
    worktree_count: boundedCount(record.worktree_count),
    terminal_count: boundedCount(record.terminal_count),
    clean_count: boundedCount(record.clean_count),
    dirty_count: boundedCount(record.dirty_count),
    dirty_path_count: boundedCount(record.dirty_path_count),
    active_task_count: boundedCount(record.active_task_count),
  };
}

function parseGithub(value: unknown): PortfolioGithubSummary {
  const record = asRecord(value);
  exactKeys(record, GITHUB_KEYS);
  return { issue_count: boundedCount(record.issue_count), pull_request_count: boundedCount(record.pull_request_count) };
}

function parseMilestones(value: unknown): readonly PortfolioMilestone[] {
  if (!Array.isArray(value) || value.length > PORTFOLIO_LIST_LIMIT) fail();
  return value.map((item) => {
    const record = asRecord(item);
    exactKeys(record, MILESTONE_KEYS);
    return { title: boundedString(record.title, PORTFOLIO_TITLE_LIMIT), state: parseLiteral(record.state, MILESTONE_STATES) };
  });
}

function parseBlockers(value: unknown): readonly PortfolioBlocker[] {
  if (!Array.isArray(value) || value.length > PORTFOLIO_LIST_LIMIT) fail();
  return value.map((item) => {
    const record = asRecord(item);
    exactKeys(record, BLOCKER_KEYS);
    if (record.kind !== "approval_required") fail();
    return { title: boundedString(record.title, PORTFOLIO_TITLE_LIMIT), kind: "approval_required" };
  });
}

function parseSource(value: unknown): PortfolioEnvironment {
  return parseLiteral(value, PORTFOLIO_ENVIRONMENTS);
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== "string" || !RFC3339_MS_PATTERN.test(value)) fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail();
  return value;
}

function parseLiteral<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string") fail();
  for (const item of allowed) {
    if (item === value) return item;
  }
  return fail();
}

function boundedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > PORTFOLIO_COUNT_MAX) fail();
  return value;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0) fail();
  const size = Buffer.byteLength(value, "utf8");
  if (size < 1 || size > max) fail();
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function rejectSecrets(value: unknown): void {
  if (typeof value === "string" && (TERMINAL_SECRET_PATTERN.test(value) || SLACK_TOKEN_PATTERN.test(value))) fail();
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) || key === "terminal_id" || key === "preview" || key === "command" || key === "receipt") fail();
    rejectSecrets(child);
  }
}
