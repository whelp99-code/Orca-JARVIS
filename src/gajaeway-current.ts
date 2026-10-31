import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { assemblePersonalContext } from "./context-assembler.js";
import { selectTimetable, type TimetableItem } from "./herdr-today.js";
import { classifyAssembledCitations } from "./personal-context-citation-contract.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import { parseObservationEnvelopeV1 } from "./personal-validation.js";

export const GAJAEWAY_LIVE_SOURCE = "src:pos:v1:gajaeway:local";
export const GAJAEWAY_FORBIDDEN_SOURCE = "src:pos:v1:orca:local";
const LINUX_HOST = "host:pos:linux-control-plane";
const SESSIONS_CURRENT = "sessions current";
const CLOSED_FIELDS = ["sessionId", "origin", "lastActivityAt", "status"] as const;

export type GajaewayCurrentSession = {
  readonly sessionId: string;
  readonly origin: string;
  readonly lastActivityAt: string | null;
  readonly status: string;
};

export type GajaewayCurrentFact = {
  readonly source_id: typeof GAJAEWAY_LIVE_SOURCE;
  readonly source_kind: "live_adapter";
  readonly host_id: typeof LINUX_HOST;
  readonly kind: "live_task";
  readonly trust: "verified";
  readonly sessionId: string;
  readonly origin: string;
  readonly lastActivityAt: string | null;
  readonly status: string;
  readonly timetable_id: string | null;
  readonly start: string | null;
};

export class GajaewayCurrentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "GajaewayCurrentError";
    this.code = code;
  }
}

function reject(code: string): never {
  throw new GajaewayCurrentError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertGajaewaySource(sourceId: string): void {
  if (sourceId === GAJAEWAY_FORBIDDEN_SOURCE || sourceId !== GAJAEWAY_LIVE_SOURCE) reject("GAJAEWAY_SOURCE_FORBIDDEN");
}

export function gajaewayMethodAllowed(command: string): boolean {
  if (command !== SESSIONS_CURRENT) reject("GAJAEWAY_METHOD_FORBIDDEN");
  return true;
}

function closedSession(value: unknown): GajaewayCurrentSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== "string" || value.sessionId === "") return null;
  if (typeof value.origin !== "string" || value.origin === "") return null;
  if (!(typeof value.lastActivityAt === "string" || value.lastActivityAt === null)) return null;
  if (typeof value.status !== "string" || value.status === "") return null;
  return {
    sessionId: value.sessionId,
    origin: value.origin,
    lastActivityAt: value.lastActivityAt,
    status: value.status,
  };
}

function oneSession(result: unknown): GajaewayCurrentSession | null {
  if (Array.isArray(result)) return result.length === 1 ? closedSession(result[0]) : null;
  if (!isRecord(result)) return null;
  if (result.reason === "ambiguous") return null;
  if (Array.isArray(result.sessions)) return result.sessions.length === 1 ? closedSession(result.sessions[0]) : null;
  if (Array.isArray(result.current)) return result.current.length === 1 ? closedSession(result.current[0]) : null;
  if (!isRecord(result.current)) return null;
  return closedSession(result.current);
}

function positivePid(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function statusPid(result: unknown): number | null {
  if (!isRecord(result) || !isRecord(result.status)) return null;
  return positivePid(result.status.pid);
}

function systemctlMainPid(value: unknown): number | null {
  if (typeof value === "string") {
    const match = /^MainPID=([0-9]+)$/m.exec(value);
    return match === null ? null : positivePid(match[1]);
  }
  if (!isRecord(value)) return null;
  return positivePid(value.MainPID);
}

export function collectGajaewayCurrent(input: {
  readonly command?: string;
  readonly result: unknown;
  readonly systemctl?: unknown;
  readonly sourceId?: string;
  readonly timetable?: readonly TimetableItem[];
}): readonly GajaewayCurrentFact[] {
  gajaewayMethodAllowed(input.command ?? SESSIONS_CURRENT);
  assertGajaewaySource(input.sourceId ?? GAJAEWAY_LIVE_SOURCE);
  if (isRecord(input.result) && typeof input.result.source_id === "string") assertGajaewaySource(input.result.source_id);
  const pid = statusPid(input.result);
  const mainPid = systemctlMainPid(input.systemctl);
  if (pid === null || mainPid === null || pid !== mainPid) return [];
  const session = oneSession(input.result);
  if (session === null) return [];
  const named = selectTimetable(input.timetable ?? []);
  const tagged = named !== null && named.id !== "";
  return [{
    source_id: GAJAEWAY_LIVE_SOURCE,
    source_kind: "live_adapter",
    host_id: LINUX_HOST,
    kind: "live_task",
    trust: "verified",
    sessionId: session.sessionId,
    origin: session.origin,
    lastActivityAt: session.lastActivityAt,
    status: session.status,
    timetable_id: tagged ? named.id : null,
    start: tagged ? named.start : null,
  }];
}

export function gajaewayFactEnvelope(fact: GajaewayCurrentFact, checkedAt: string): ObservationEnvelopeV1 {
  assertGajaewaySource(fact.source_id);
  if (fact.trust !== "verified") reject("GAJAEWAY_TRUST_UNVERIFIED");
  const value = {
    sessionId: fact.sessionId,
    origin: fact.origin,
    lastActivityAt: fact.lastActivityAt,
    status: fact.status,
    ...(fact.timetable_id === null ? {} : { timetable_id: fact.timetable_id, start: fact.start }),
  };
  const digest = `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
  const hex = digest.slice(7);
  const identity = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
  const observedAt = new Date(Date.parse(checkedAt) - 1_000).toISOString();
  return parseObservationEnvelopeV1({
    schema_version: 1,
    id: `obs:pos:v1:${fact.source_id}:${identity}`,
    created_at: checkedAt,
    observed_at: observedAt,
    valid_at: observedAt,
    source: {
      source_id: fact.source_id,
      source_kind: fact.source_kind,
      host_id: fact.host_id,
      source_version: "gajaeway-sessions-current-v1",
      evidence_ref: `gajaeway:${fact.sessionId}`,
    },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: {
      state: "fresh", checked_at: checkedAt,
      fresh_until: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
    },
    expires_at: new Date(Date.parse(checkedAt) + 3_600_000).toISOString(),
    idempotency_key: `idem:pos:v1:gajaeway:${hex}`,
    correlation_id: `corr:pos:v1:${identity}`,
    causation_id: null,
    payload: {
      kind: fact.kind, subject: `session:${fact.sessionId}`, value, trust: fact.trust, sensitivity: "personal",
      cursor: fact.sessionId, checkpoint: fact.sessionId,
      content_digest: digest, state: "fresh",
    },
    policy_decision: { decision: "allow", policy_version: "personal-observation-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence: [{
      evidence_id: `evi:pos:v1:${identity}`, digest, kind: "structured_ref",
      source_id: fact.source_id, observed_at: observedAt,
    }],
    receipt: null,
  });
}

export function classifyGajaewayFact(fact: GajaewayCurrentFact, checkedAt: string): number {
  if (fact.trust !== "verified") return 0;
  const observation = gajaewayFactEnvelope(fact, checkedAt);
  const classified = classifyAssembledCitations(assemblePersonalContext({
    purpose: "daily_prioritization", query: "today", clock: checkedAt, expires_in_ms: 240_000,
    budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 },
    observations: [observation], pending_authority_refs: [], memories: [],
  }), [observation], []);
  return classified.citable.filter(item => item.citation_kind === "linux_live_fact").length;
}

export function gajaewayCollectorSideEffects(): readonly string[] {
  return [];
}

export const GAJAEWAY_FACT_FIELDS = CLOSED_FIELDS;
