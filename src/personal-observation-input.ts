import type { PortfolioEnvironment } from "./dashboard/portfolio-contracts.js";
import type { StoredObservation } from "./personal-observation-store.js";
import type { TaskTimelineContext, TaskTimelineEvent, TaskTimelineSummary } from "./task-timeline.js";

export const PERSONAL_OBSERVATION_ERROR_CODES = [
  "PERSONAL_OBSERVATION_INPUT_INVALID",
  "PERSONAL_OBSERVATION_AMBIGUOUS_TERMINAL",
  "PERSONAL_OBSERVATION_STALE_INCARNATION",
  "PERSONAL_OBSERVATION_OUT_OF_ORDER",
  "PERSONAL_OBSERVATION_EVIDENCE_REQUIRED",
  "PERSONAL_OBSERVATION_HOST_COLLISION",
  "PERSONAL_OBSERVATION_PRIVATE_INPUT",
] as const;
export type PersonalObservationErrorCode = (typeof PERSONAL_OBSERVATION_ERROR_CODES)[number];

export class PersonalObservationNormalizationError extends Error {
  readonly name = "PersonalObservationNormalizationError";
  constructor(readonly code: PersonalObservationErrorCode) {
    super(code);
  }
}

export type PersonalObservationEnvironment = "local" | "jm-server" | "mac-client";
export type OrcaTaskObservationInput = {
  readonly environment: PersonalObservationEnvironment;
  readonly worktree: string;
  readonly worktree_id: string;
  readonly terminal_id: string;
  readonly session_id: string;
  readonly incarnation_id: string;
  readonly pty_id: string;
  readonly cursor: string;
  readonly working: boolean;
  readonly timeline: TaskTimelineContext;
};
export type SignedPortfolioObservationInput = {
  readonly environment: PortfolioEnvironment;
  readonly envelope: Buffer;
  readonly key: Buffer;
  readonly received_at: string;
};
export type PersonalObservationNormalizationInput = {
  readonly checked_at: string;
  readonly orca_tasks: readonly OrcaTaskObservationInput[];
  readonly portfolios: readonly SignedPortfolioObservationInput[];
};
export type PersonalObservationPersistence = {
  readonly persistObservation: (value: unknown, now: string) => StoredObservation;
};
export type PersonalObservationPersistenceInput = {
  readonly input: PersonalObservationNormalizationInput;
  readonly store: PersonalObservationPersistence;
  readonly persisted_at: string;
};

type Row = Readonly<Record<string, unknown>>;
const INPUT_KEYS = ["checked_at", "orca_tasks", "portfolios"] as const;
const TASK_KEYS = [
  "environment", "worktree", "worktree_id", "terminal_id", "session_id", "incarnation_id", "pty_id", "cursor", "working", "timeline",
] as const;
const PORTFOLIO_KEYS = ["environment", "envelope", "key", "received_at"] as const;
const TIMELINE_KEYS = [
  "schema_version", "generated_at", "task", "events", "pending_decisions", "workers", "evidence", "truncated",
] as const;
const SUMMARY_KEYS = [
  "task_id", "title", "kind", "state", "updated_at", "pending_approval", "source_ids",
] as const;
const EVENT_KEYS = [
  "event_id", "task_id", "source", "kind", "actor", "title", "status", "payload", "evidence_refs", "created_at", "sequence",
] as const;
const ENVIRONMENTS = ["local", "jm-server", "mac-client"] as const;
const PORTFOLIO_ENVIRONMENTS = ["local", "jm-server"] as const;
const SUMMARY_KINDS = ["work", "command", "workflow", "agent"] as const;
const EVENT_SOURCES = ["work", "control", "workflow", "gjc", "verification", "progress"] as const;
const EVENT_KINDS = ["status", "command", "approval", "workflow", "agent", "verification", "evidence", "system"] as const;
const PRIVATE_KEY = /(?:^|_)(?:body|command|preview|prose|secret|tail|text|token)(?:$|_)/iu;

function fail(): never {
  throw new PersonalObservationNormalizationError("PERSONAL_OBSERVATION_INPUT_INVALID");
}
function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}
function exact(value: unknown, keys: readonly string[]): value is Row {
  return isRow(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && values.some(candidate => candidate === value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function validTime(value: unknown): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function rejectPrivate(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPrivate(item);
    return;
  }
  if (!isRow(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) {
      throw new PersonalObservationNormalizationError("PERSONAL_OBSERVATION_PRIVATE_INPUT");
    }
    rejectPrivate(child);
  }
}
function isSummary(value: unknown): value is TaskTimelineSummary {
  return exact(value, SUMMARY_KEYS)
    && nonempty(value["task_id"])
    && typeof value["title"] === "string"
    && member(value["kind"], SUMMARY_KINDS)
    && nonempty(value["state"])
    && validTime(value["updated_at"])
    && typeof value["pending_approval"] === "boolean"
    && stringArray(value["source_ids"]);
}
function isEvent(value: unknown): value is TaskTimelineEvent {
  return exact(value, EVENT_KEYS)
    && nonempty(value["event_id"])
    && nonempty(value["task_id"])
    && member(value["source"], EVENT_SOURCES)
    && member(value["kind"], EVENT_KINDS)
    && nonempty(value["actor"])
    && typeof value["title"] === "string"
    && (value["status"] === null || typeof value["status"] === "string")
    && stringArray(value["evidence_refs"])
    && validTime(value["created_at"])
    && Number.isInteger(value["sequence"]);
}
function isTimeline(value: unknown): value is TaskTimelineContext {
  return exact(value, TIMELINE_KEYS)
    && value["schema_version"] === 1
    && validTime(value["generated_at"])
    && isSummary(value["task"])
    && Array.isArray(value["events"])
    && value["events"].every(isEvent)
    && Array.isArray(value["pending_decisions"])
    && Array.isArray(value["workers"])
    && Array.isArray(value["evidence"])
    && typeof value["truncated"] === "boolean";
}
function parseTask(value: unknown): OrcaTaskObservationInput {
  if (!exact(value, TASK_KEYS)) return fail();
  const environment = value["environment"];
  const worktree = value["worktree"];
  const worktreeId = value["worktree_id"];
  const terminalId = value["terminal_id"];
  const sessionId = value["session_id"];
  const incarnationId = value["incarnation_id"];
  const ptyId = value["pty_id"];
  const cursor = value["cursor"];
  const working = value["working"];
  const timeline = value["timeline"];
  if (!member(environment, ENVIRONMENTS)
    || !nonempty(worktree)
    || !nonempty(worktreeId)
    || !nonempty(terminalId)
    || !nonempty(sessionId)
    || !nonempty(incarnationId)
    || !nonempty(ptyId)
    || !nonempty(cursor)
    || typeof working !== "boolean"
    || !isTimeline(timeline)) return fail();
  if (!worktree.startsWith("/") || timeline.events.some(event => event.task_id !== timeline.task.task_id)) return fail();
  return {
    environment,
    worktree,
    worktree_id: worktreeId,
    terminal_id: terminalId,
    session_id: sessionId,
    incarnation_id: incarnationId,
    pty_id: ptyId,
    cursor,
    working,
    timeline,
  };
}
function parsePortfolio(value: unknown): SignedPortfolioObservationInput {
  if (!exact(value, PORTFOLIO_KEYS)) return fail();
  const environment = value["environment"];
  const envelope = value["envelope"];
  const key = value["key"];
  const receivedAt = value["received_at"];
  if (!member(environment, PORTFOLIO_ENVIRONMENTS)
    || !Buffer.isBuffer(envelope)
    || !Buffer.isBuffer(key)
    || !validTime(receivedAt)) return fail();
  return { environment, envelope, key, received_at: receivedAt };
}

export function parsePersonalObservationInput(value: unknown): PersonalObservationNormalizationInput {
  rejectPrivate(value);
  if (!exact(value, INPUT_KEYS)) return fail();
  const checkedAt = value["checked_at"];
  const tasks = value["orca_tasks"];
  const portfolios = value["portfolios"];
  if (!validTime(checkedAt) || !Array.isArray(tasks) || !Array.isArray(portfolios)) return fail();
  return {
    checked_at: checkedAt,
    orca_tasks: tasks.map(parseTask),
    portfolios: portfolios.map(parsePortfolio),
  };
}
