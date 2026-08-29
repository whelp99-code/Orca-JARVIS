import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { verifyPortfolioAuthenticatedReport } from "./dashboard/portfolio-auth.js";
import type { PortfolioEnvironment, PortfolioReportV1, PortfolioVerifiedPayload } from "./dashboard/portfolio-contracts.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import type { StoredObservation } from "./personal-observation-store.js";
import { parseObservationEnvelopeV1 } from "./personal-validation.js";
import type { TaskTimelineContext } from "./task-timeline.js";

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
  constructor(readonly code: PersonalObservationErrorCode) { super(code); }
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

type EnvelopeParts = {
  readonly sourceId: string;
  readonly sourceKind: "live_adapter" | "client";
  readonly hostId: "host:pos:linux-control-plane" | "host:pos:mac-client";
  readonly sourceVersion: string;
  readonly evidenceRef: string;
  readonly kind: string;
  readonly subject: string;
  readonly value: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly cursor: string;
  readonly checkpoint: string;
  readonly observedAt: string;
  readonly checkedAt: string;
  readonly evidenceRefs: readonly string[];
};

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function uuid(value: unknown): string {
  const hex = createHash("sha256").update(canonicalize(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function envelope(parts: EnvelopeParts): ObservationEnvelopeV1 {
  const contentDigest = digest(parts.value);
  const identity = uuid({ source: parts.sourceId, subject: parts.subject, checkpoint: parts.checkpoint, contentDigest });
  return parseObservationEnvelopeV1({
    schema_version: 1,
    id: `obs:pos:v1:${parts.sourceId}:${identity}`,
    created_at: parts.checkedAt,
    observed_at: parts.observedAt,
    valid_at: parts.observedAt,
    source: { source_id: parts.sourceId, source_kind: parts.sourceKind, host_id: parts.hostId, source_version: parts.sourceVersion, evidence_ref: parts.evidenceRef },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: parts.checkedAt, fresh_until: addMilliseconds(parts.checkedAt, 300_000) },
    expires_at: addMilliseconds(parts.checkedAt, 3_600_000),
    idempotency_key: `idem:pos:v1:observation:${digest({ source: parts.sourceId, subject: parts.subject, checkpoint: parts.checkpoint }).slice(7)}`,
    correlation_id: `corr:pos:v1:${uuid({ subject: parts.subject })}`,
    causation_id: null,
    payload: { kind: parts.kind, subject: parts.subject, value: parts.value, trust: "verified", sensitivity: "personal", cursor: parts.cursor, checkpoint: parts.checkpoint, content_digest: contentDigest, state: "fresh" },
    policy_decision: { decision: "allow", policy_version: "personal-observation-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence: [...new Set(parts.evidenceRefs)].map(reference => ({ evidence_id: `evi:pos:v1:${uuid({ reference })}`, digest: digest(reference), kind: "structured_ref", source_id: parts.sourceId, observed_at: parts.observedAt })),
    receipt: null,
  });
}

function taskEnvelope(task: OrcaTaskObservationInput, checkedAt: string): ObservationEnvelopeV1 {
  const decisions = task.timeline.events.filter(event => event.kind === "approval").map(event => event.event_id);
  const evidenceRefs = [...new Set(task.timeline.events.flatMap(event => event.evidence_refs))];
  const client = task.environment === "mac-client";
  const sourceId = client ? "src:pos:v1:mac-client:orca" : `src:pos:v1:orca:${task.environment}`;
  return envelope({
    sourceId, sourceKind: client ? "client" : "live_adapter", hostId: client ? "host:pos:mac-client" : "host:pos:linux-control-plane",
    sourceVersion: "orca-task-timeline-v1", evidenceRef: `timeline:${task.timeline.task.task_id}`, kind: "live_task",
    subject: `task:${task.timeline.task.task_id}`,
    value: { environment: task.environment, worktree: task.worktree, worktree_id: task.worktree_id, terminal_id: task.terminal_id, session_id: task.session_id, incarnation_id: task.incarnation_id, pty_id: task.pty_id, cursor: task.cursor, task_id: task.timeline.task.task_id, task_state: task.timeline.task.state, working: task.working, decision_ids: decisions, evidence_refs: evidenceRefs },
    cursor: task.cursor, checkpoint: `${task.incarnation_id}:${task.cursor}`, observedAt: task.timeline.task.updated_at, checkedAt, evidenceRefs,
  });
}

function verifiedReport(value: PortfolioVerifiedPayload): PortfolioReportV1 {
  switch (value.kind) {
    case "report": return value.report;
    case "error": return fail("PERSONAL_OBSERVATION_INPUT_INVALID");
    default: { const exhaustive: never = value; return exhaustive; }
  }
}
function portfolioEnvelope(input: SignedPortfolioObservationInput, checkedAt: string): ObservationEnvelopeV1 {
  const report = verifiedReport(verifyPortfolioAuthenticatedReport(input.envelope, input.key, input.environment));
  const reportDigest = digest(report);
  return envelope({
    sourceId: `src:pos:v1:portfolio:${report.source}`, sourceKind: "live_adapter", hostId: "host:pos:linux-control-plane",
    sourceVersion: "portfolio-auth-v1", evidenceRef: reportDigest, kind: "portfolio", subject: `portfolio:${report.source}`,
    value: { environment: report.source, reported_at: report.reported_at, report_digest: reportDigest, worktree_count: report.host.worktree_count, terminal_count: report.host.terminal_count, clean_count: report.host.clean_count, dirty_count: report.host.dirty_count, dirty_path_count: report.host.dirty_path_count, active_task_count: report.host.active_task_count },
    cursor: reportDigest, checkpoint: report.reported_at, observedAt: report.reported_at, checkedAt, evidenceRefs: [reportDigest],
  });
}

const INPUT_KEYS = ["checked_at", "orca_tasks", "portfolios"] as const;
const TASK_KEYS = ["environment", "worktree", "worktree_id", "terminal_id", "session_id", "incarnation_id", "pty_id", "cursor", "working", "timeline"] as const;
const PORTFOLIO_KEYS = ["environment", "envelope", "key", "received_at"] as const;
const PRIVATE_KEY = /(?:^|_)(?:body|command|preview|prose|secret|tail|text|token)(?:$|_)/iu;
const COMPLETION_STATES = ["completed", "done"] as const;

function fail(code: PersonalObservationErrorCode): never {
  throw new PersonalObservationNormalizationError(code);
}
function rejectPrivate(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectPrivate(item); return; }
  if (typeof value !== "object" || value === null || Buffer.isBuffer(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) fail("PERSONAL_OBSERVATION_PRIVATE_INPUT");
    rejectPrivate(child);
  }
}
function validateTask(task: OrcaTaskObservationInput): void {
  rejectPrivate(task);
  const keys = Object.keys(task);
  const extra = keys.find(key => !TASK_KEYS.some(candidate => candidate === key));
  if (extra !== undefined) fail(PRIVATE_KEY.test(extra) ? "PERSONAL_OBSERVATION_PRIVATE_INPUT" : "PERSONAL_OBSERVATION_INPUT_INVALID");
  const strings = [task.worktree, task.worktree_id, task.terminal_id, task.session_id, task.incarnation_id, task.pty_id, task.cursor, task.timeline.task.task_id];
  if (!strings.every(value => typeof value === "string" && value.length > 0) || typeof task.working !== "boolean") fail("PERSONAL_OBSERVATION_INPUT_INVALID");
  if (!task.worktree.startsWith("/") || task.timeline.events.some(event => event.task_id !== task.timeline.task.task_id)) fail("PERSONAL_OBSERVATION_INPUT_INVALID");
  const completed = COMPLETION_STATES.some(state => state === task.timeline.task.state);
  const evidenceRefs = task.timeline.events.flatMap(event => event.evidence_refs);
  if (completed && evidenceRefs.length === 0) fail("PERSONAL_OBSERVATION_EVIDENCE_REQUIRED");
}
function validateTasks(tasks: readonly OrcaTaskObservationInput[]): void {
  const identities = new Map<string, OrcaTaskObservationInput>();
  for (const task of tasks) {
    validateTask(task);
    const identity = `${task.worktree_id}\0${task.terminal_id}`;
    const prior = identities.get(identity);
    if (prior !== undefined) {
      if (prior.environment !== task.environment) fail("PERSONAL_OBSERVATION_HOST_COLLISION");
      if (prior.incarnation_id !== task.incarnation_id) fail("PERSONAL_OBSERVATION_STALE_INCARNATION");
      fail("PERSONAL_OBSERVATION_AMBIGUOUS_TERMINAL");
    }
    identities.set(identity, task);
  }
}
function validatePortfolios(portfolios: readonly SignedPortfolioObservationInput[], checkedAt: string): void {
  const latest = new Map<PortfolioEnvironment, string>();
  for (const portfolio of portfolios) {
    if (Object.keys(portfolio).some(key => !PORTFOLIO_KEYS.some(candidate => candidate === key))) fail("PERSONAL_OBSERVATION_INPUT_INVALID");
    const report = verifiedReport(verifyPortfolioAuthenticatedReport(portfolio.envelope, portfolio.key, portfolio.environment));
    const reportedAt = report.reported_at;
    if (Date.parse(reportedAt) > Date.parse(portfolio.received_at) || Date.parse(portfolio.received_at) > Date.parse(checkedAt)) fail("PERSONAL_OBSERVATION_INPUT_INVALID");
    const prior = latest.get(portfolio.environment);
    if (prior !== undefined && reportedAt < prior) fail("PERSONAL_OBSERVATION_OUT_OF_ORDER");
    latest.set(portfolio.environment, reportedAt);
  }
}

export function normalizePersonalObservations(input: PersonalObservationNormalizationInput): readonly ObservationEnvelopeV1[] {
  if (Object.keys(input).some(key => !INPUT_KEYS.some(candidate => candidate === key)) || !Number.isFinite(Date.parse(input.checked_at))) fail("PERSONAL_OBSERVATION_INPUT_INVALID");
  validateTasks(input.orca_tasks);
  validatePortfolios(input.portfolios, input.checked_at);
  return [
    ...input.orca_tasks.map(task => taskEnvelope(task, input.checked_at)),
    ...input.portfolios.map(portfolio => portfolioEnvelope(portfolio, input.checked_at)),
  ];
}

export function normalizeAndPersistPersonalObservations(input: PersonalObservationPersistenceInput): readonly StoredObservation[] {
  return normalizePersonalObservations(input.input).map(observation => input.store.persistObservation(observation, input.persisted_at));
}
