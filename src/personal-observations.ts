import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { verifyPortfolioAuthenticatedReport } from "./dashboard/portfolio-auth.js";
import type {
  PortfolioEnvironment,
  PortfolioReportV1,
  PortfolioVerifiedPayload,
} from "./dashboard/portfolio-contracts.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import {
  PersonalObservationNormalizationError,
  parsePersonalObservationInput,
  type OrcaTaskObservationInput,
  type PersonalObservationErrorCode,
  type PersonalObservationNormalizationInput,
  type PersonalObservationPersistenceInput,
  type SignedPortfolioObservationInput,
} from "./personal-observation-input.js";
import type { StoredObservation } from "./personal-observation-store.js";
import { parseObservationEnvelopeV1 } from "./personal-validation.js";

export {
  PERSONAL_OBSERVATION_ERROR_CODES,
  PersonalObservationNormalizationError,
  type OrcaTaskObservationInput,
  type PersonalObservationEnvironment,
  type PersonalObservationErrorCode,
  type PersonalObservationNormalizationInput,
  type PersonalObservationPersistence,
  type PersonalObservationPersistenceInput,
  type SignedPortfolioObservationInput,
} from "./personal-observation-input.js";

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

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function uuid(value: unknown): string {
  const hex = createHash("sha256").update(canonicalize(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}
function fail(code: PersonalObservationErrorCode): never {
  throw new PersonalObservationNormalizationError(code);
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
    source: {
      source_id: parts.sourceId,
      source_kind: parts.sourceKind,
      host_id: parts.hostId,
      source_version: parts.sourceVersion,
      evidence_ref: parts.evidenceRef,
    },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: {
      state: "fresh",
      checked_at: parts.checkedAt,
      fresh_until: addMilliseconds(parts.checkedAt, 300_000),
    },
    expires_at: addMilliseconds(parts.checkedAt, 3_600_000),
    idempotency_key: `idem:pos:v1:observation:${digest({
      source: parts.sourceId,
      subject: parts.subject,
      checkpoint: parts.checkpoint,
    }).slice(7)}`,
    correlation_id: `corr:pos:v1:${uuid({ subject: parts.subject })}`,
    causation_id: null,
    payload: {
      kind: parts.kind,
      subject: parts.subject,
      value: parts.value,
      trust: "verified",
      sensitivity: "personal",
      cursor: parts.cursor,
      checkpoint: parts.checkpoint,
      content_digest: contentDigest,
      state: "fresh",
    },
    policy_decision: {
      decision: "allow",
      policy_version: "personal-observation-v1",
      reason_codes: ["POLICY_SATISFIED"],
    },
    evidence: [...new Set(parts.evidenceRefs)].map(reference => ({
      evidence_id: `evi:pos:v1:${uuid({ reference })}`,
      digest: digest(reference),
      kind: "structured_ref",
      source_id: parts.sourceId,
      observed_at: parts.observedAt,
    })),
    receipt: null,
  });
}

function taskEnvelope(task: OrcaTaskObservationInput, checkedAt: string): ObservationEnvelopeV1 {
  const decisions = task.timeline.events.filter(event => event.kind === "approval").map(event => event.event_id);
  const evidenceRefs = [...new Set(task.timeline.events.flatMap(event => event.evidence_refs))];
  const client = task.environment === "mac-client";
  const sourceId = client ? "src:pos:v1:mac-client:orca" : `src:pos:v1:orca:${task.environment}`;
  return envelope({
    sourceId,
    sourceKind: client ? "client" : "live_adapter",
    hostId: client ? "host:pos:mac-client" : "host:pos:linux-control-plane",
    sourceVersion: "orca-task-timeline-v1",
    evidenceRef: `timeline:${task.timeline.task.task_id}`,
    kind: "live_task",
    subject: `task:${task.timeline.task.task_id}`,
    value: {
      environment: task.environment,
      worktree: task.worktree,
      worktree_id: task.worktree_id,
      terminal_id: task.terminal_id,
      session_id: task.session_id,
      incarnation_id: task.incarnation_id,
      pty_id: task.pty_id,
      cursor: task.cursor,
      task_id: task.timeline.task.task_id,
      task_state: task.timeline.task.state,
      working: task.working,
      decision_ids: decisions,
    },
    cursor: task.cursor,
    checkpoint: `${task.incarnation_id}:${task.cursor}`,
    observedAt: task.timeline.task.updated_at,
    checkedAt,
    evidenceRefs,
  });
}

function verifiedReport(value: PortfolioVerifiedPayload): PortfolioReportV1 {
  switch (value.kind) {
    case "report":
      return value.report;
    case "error":
      return fail("PERSONAL_OBSERVATION_INPUT_INVALID");
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}
function portfolioEnvelope(input: SignedPortfolioObservationInput, checkedAt: string): ObservationEnvelopeV1 {
  const report = verifiedReport(verifyPortfolioAuthenticatedReport(input.envelope, input.key, input.environment));
  const reportDigest = digest(report);
  return envelope({
    sourceId: `src:pos:v1:portfolio:${report.source}`,
    sourceKind: "live_adapter",
    hostId: "host:pos:linux-control-plane",
    sourceVersion: "portfolio-auth-v1",
    evidenceRef: reportDigest,
    kind: "portfolio",
    subject: `portfolio:${report.source}`,
    value: {
      environment: report.source,
      reported_at: report.reported_at,
      report_digest: reportDigest,
      worktree_count: report.host.worktree_count,
      terminal_count: report.host.terminal_count,
      clean_count: report.host.clean_count,
      dirty_count: report.host.dirty_count,
      dirty_path_count: report.host.dirty_path_count,
      active_task_count: report.host.active_task_count,
    },
    cursor: reportDigest,
    checkpoint: report.reported_at,
    observedAt: report.reported_at,
    checkedAt,
    evidenceRefs: [reportDigest],
  });
}

const COMPLETION_STATES = ["completed", "done"] as const;

function validateTasks(tasks: readonly OrcaTaskObservationInput[]): void {
  const identities = new Map<string, OrcaTaskObservationInput>();
  for (const task of tasks) {
    const completed = COMPLETION_STATES.some(state => state === task.timeline.task.state);
    const evidenceRefs = task.timeline.events.flatMap(event => event.evidence_refs);
    if (completed && evidenceRefs.length === 0) fail("PERSONAL_OBSERVATION_EVIDENCE_REQUIRED");
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
    const report = verifiedReport(verifyPortfolioAuthenticatedReport(
      portfolio.envelope,
      portfolio.key,
      portfolio.environment,
    ));
    const reportedAt = report.reported_at;
    if (Date.parse(reportedAt) > Date.parse(portfolio.received_at)
      || Date.parse(portfolio.received_at) > Date.parse(checkedAt)) {
      fail("PERSONAL_OBSERVATION_INPUT_INVALID");
    }
    const prior = latest.get(portfolio.environment);
    if (prior !== undefined && reportedAt < prior) fail("PERSONAL_OBSERVATION_OUT_OF_ORDER");
    latest.set(portfolio.environment, reportedAt);
  }
}

export function normalizePersonalObservations(
  input: PersonalObservationNormalizationInput,
): readonly ObservationEnvelopeV1[];
export function normalizePersonalObservations(input: unknown): readonly ObservationEnvelopeV1[] {
  const parsed = parsePersonalObservationInput(input);
  validateTasks(parsed.orca_tasks);
  validatePortfolios(parsed.portfolios, parsed.checked_at);
  return [
    ...parsed.orca_tasks.map(task => taskEnvelope(task, parsed.checked_at)),
    ...parsed.portfolios.map(portfolio => portfolioEnvelope(portfolio, parsed.checked_at)),
  ];
}

export function normalizeAndPersistPersonalObservations(
  input: PersonalObservationPersistenceInput,
): readonly StoredObservation[] {
  const observations = normalizePersonalObservations(input.input);
  if (input.store.persistObservationBatch !== undefined) return input.store.persistObservationBatch(observations, input.persisted_at);
  return observations.map(observation =>
    input.store.persistObservation(observation, input.persisted_at));
}
