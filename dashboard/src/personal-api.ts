import { DashboardApiError, type SessionResponse } from "./api.js";
import { parseHealthItem } from "./personal-health-parser.js";
import { requestPersonalJson } from "./personal-http.js";
import type {
  AcceptedAction,
  Citation,
  ContextEvidence,
  DailyRun,
  DecisionItem,
  EvidenceItem,
  NotificationItem,
  PersonalClient,
  PersonalPage,
  RecommendationDetail,
  ResourceQuality,
  TodayAction,
  TodayResponse,
} from "./personal-types.js";
export type * from "./personal-types.js";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const QUALITY = ["ready", "degraded", "no_data", "offline", "stale"] as const;
const MAX_ITEMS = 100;
const MAX_TEXT = 4096;
const ACCEPT_KEYS = ["schema_version", "recommendation_id", "action_rank", "request_id", "action", "state"] as const;

type SessionLoader = () => Promise<SessionResponse>;

export function createPersonalClient(loadSession: SessionLoader): PersonalClient {
  return {
    today: async () => parseToday(await get("/api/v1/today")),
    decisions: async () => parsePage(await get("/api/v1/decision-inbox?limit=100"), "decision-inbox", parseDecision),
    notifications: async () => parsePage(await get("/api/v1/notification-intents?limit=100"), "notification-intents", parseNotification),
    health: async () => parsePage(await get("/api/v1/source-health?limit=100"), "source-health", parseHealthItem),
    recommendation: async (id) => parseRecommendation(await get(`/api/v1/recommendations/${encodeURIComponent(id)}`)),
    evidence: async (link) => parseEvidence(await get(safeLink(link))),
    accept: async (id, rank) => {
      const session = await loadSession();
      return parseAccepted(await requestPersonalJson(`/api/v1/recommendations/${encodeURIComponent(id)}/actions/${String(rank)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-JARVIS-CSRF": session.csrf_token },
        body: JSON.stringify({ schema_version: 1 }),
      }));
    },
  };
}

async function get(path: string): Promise<unknown> {
  return await requestPersonalJson(path, { headers: { Accept: "application/json" } });
}

function parseToday(value: unknown): TodayResponse {
  const row = exact(value, ["schema_version", "resource", "generated_at", "state", "brief", "active_decision_count",
    "notification_summary", "current_daily_run", "last_daily_run", "latest_verified_closeout", "next_actions", "conflicts",
    "omissions", "freshness", "deep_links"]);
  const brief = exact(row["brief"], ["state", "brief_id", "generated_at", "item_count"]);
  const notifications = exact(row["notification_summary"], ["total", "states"]);
  const freshness = exact(row["freshness"], ["state", "checked_at", "fresh_until"]);
  const links = exact(row["deep_links"], ["decisions", "daily_runs", "notifications", "source_health"]);
  const actions = array(row["next_actions"], parseTodayAction, 3);
  return {
    schema_version: literal(row["schema_version"], 1), resource: literal(row["resource"], "today"),
    generated_at: time(row["generated_at"]), state: quality(row["state"]),
    brief: { state: text(brief["state"]), brief_id: nullableText(brief["brief_id"]),
      generated_at: nullableTime(brief["generated_at"]), item_count: integer(brief["item_count"]) },
    active_decision_count: integer(row["active_decision_count"]),
    notification_summary: { total: integer(notifications["total"]), states: array(notifications["states"], (entry) => {
      const item = exact(entry, ["state", "count"]); return { state: text(item["state"]), count: integer(item["count"]) };
    }, MAX_ITEMS) },
    current_daily_run: nullableRecord(row["current_daily_run"]), last_daily_run: nullableRecord(row["last_daily_run"]),
    latest_verified_closeout: closeout(row["latest_verified_closeout"]), next_actions: actions,
    conflicts: strings(row["conflicts"]), omissions: strings(row["omissions"]),
    freshness: { state: text(freshness["state"]), checked_at: nullableTime(freshness["checked_at"]),
      fresh_until: nullableTime(freshness["fresh_until"]) },
    deep_links: { decisions: path(links["decisions"]), daily_runs: path(links["daily_runs"]),
      notifications: path(links["notifications"]), source_health: path(links["source_health"]) },
  };
}

function parseTodayAction(value: unknown): TodayAction {
  const row = exact(value, ["recommendation_id", "rank", "title", "confidence_class", "expires_at", "deep_link"]);
  return { recommendation_id: text(row["recommendation_id"]), rank: integer(row["rank"]), title: text(row["title"]),
    confidence_class: text(row["confidence_class"]), expires_at: time(row["expires_at"]), deep_link: path(row["deep_link"]) };
}

function parsePage<T>(value: unknown, resource: string, item: (value: unknown) => T): PersonalPage<T> {
  const row = exact(value, ["schema_version", "resource", "generated_at", "state", "items", "page"]);
  literal(row["schema_version"], 1);
  literal(row["resource"], resource);
  const page = exact(row["page"], ["limit", "returned", "total", "has_more", "next_cursor"]);
  integer(page["limit"]); integer(page["returned"]); integer(page["total"]);
  bool(page["has_more"]); nullableText(page["next_cursor"]);
  return { schema_version: 1, generated_at: time(row["generated_at"]), state: quality(row["state"]),
    items: array(row["items"], item, MAX_ITEMS) };
}

function parseDecision(value: unknown): DecisionItem {
  const row = exact(value, ["recommendation_id", "context_id", "rank", "title", "state", "confidence_class", "occurred_at",
    "expires_at", "evidence_digest", "identity_digest", "provenance_digest", "citations", "deep_link"]);
  digest(row["evidence_digest"]); digest(row["identity_digest"]); digest(row["provenance_digest"]);
  return { recommendation_id: text(row["recommendation_id"]), context_id: text(row["context_id"]), rank: integer(row["rank"]),
    title: text(row["title"]), state: text(row["state"]), confidence_class: text(row["confidence_class"]), occurred_at: time(row["occurred_at"]),
    expires_at: time(row["expires_at"]), citations: array(row["citations"], parseCitation, MAX_ITEMS),
    deep_link: path(row["deep_link"]) };
}

function parseCitation(value: unknown): Citation {
  const row = exact(value, ["context_evidence_id", "digest", "kind", "ref"]);
  return { context_evidence_id: nullableText(row["context_evidence_id"]), digest: text(row["digest"]),
    kind: text(row["kind"]), ref: text(row["ref"]) };
}

function parseNotification(value: unknown): NotificationItem {
  const row = exact(value, ["intent_id", "correlation_id", "urgency", "channel", "preview", "deep_link", "state", "expires_at", "created_at", "updated_at"]);
  text(row["correlation_id"]); time(row["created_at"]);
  return { intent_id: text(row["intent_id"]), urgency: text(row["urgency"]), channel: text(row["channel"]), preview: text(row["preview"]),
    deep_link: path(row["deep_link"]), state: text(row["state"]), expires_at: time(row["expires_at"]), updated_at: time(row["updated_at"]) };
}

function parseRecommendation(value: unknown): RecommendationDetail {
  const row = exact(value, ["schema_version", "resource", "recommendation_id", "context_id", "canonical_digest", "evidence_digest",
    "approval_requirement", "confidence_class", "lifecycle_state", "expires_at", "state", "actions", "evidence", "conflicts", "omissions", "deep_links"]);
  const links = exact(row["deep_links"], ["context_evidence"]); literal(row["resource"], "recommendation");
  digest(row["canonical_digest"]); digest(row["evidence_digest"]); text(row["approval_requirement"]);
  array(row["actions"], parseRecommendationAction, 32);
  return { schema_version: literal(row["schema_version"], 1), recommendation_id: text(row["recommendation_id"]), context_id: text(row["context_id"]),
    confidence_class: text(row["confidence_class"]), lifecycle_state: text(row["lifecycle_state"]), expires_at: time(row["expires_at"]),
    state: quality(row["state"]), evidence: array(row["evidence"], parseEvidenceItem, MAX_ITEMS), conflicts: strings(row["conflicts"]),
    omissions: strings(row["omissions"]), context_evidence_link: path(links["context_evidence"]) };
}

function parseRecommendationAction(value: unknown): void {
  const row = exact(value, ["rank", "title", "operation", "target_digest", "state", "owner_decision_required",
    "current", "occurred_at", "transition_digest"]);
  integer(row["rank"]); text(row["title"]); text(row["operation"]); digest(row["target_digest"]);
  text(row["state"]); bool(row["owner_decision_required"]); bool(row["current"]); time(row["occurred_at"]);
  if (row["transition_digest"] !== null) digest(row["transition_digest"]);
}

function parseEvidence(value: unknown): ContextEvidence {
  const row = exact(value, [
    "schema_version", "resource", "context_id", "recommendation_id", "state",
    "freshness", "evidence", "conflicts", "omissions",
  ]);
  literal(row["resource"], "context-evidence");
  const freshness = exact(row["freshness"], ["state", "fresh_until"]);
  text(freshness["state"]); time(freshness["fresh_until"]);
  return {
    schema_version: literal(row["schema_version"], 1),
    context_id: text(row["context_id"]),
    recommendation_id: text(row["recommendation_id"]),
    state: quality(row["state"]),
    evidence: array(row["evidence"], parseEvidenceItem, MAX_ITEMS),
    conflicts: strings(row["conflicts"]),
    omissions: strings(row["omissions"]),
  };
}

function parseEvidenceItem(value: unknown): EvidenceItem {
  const row = exact(value, ["evidence_id", "source_id", "kind", "digest", "observed_at", "fresh_until"]);
  return { evidence_id: text(row["evidence_id"]), source_id: text(row["source_id"]), kind: text(row["kind"]), digest: text(row["digest"]),
    observed_at: time(row["observed_at"]), fresh_until: nullableTime(row["fresh_until"]) };
}
function parseAccepted(value: unknown): AcceptedAction {
  const row = exact(value, ACCEPT_KEYS);
  return { schema_version: literal(row["schema_version"], 1), recommendation_id: text(row["recommendation_id"]), action_rank: integer(row["action_rank"]),
    request_id: text(row["request_id"]), action: literal(row["action"], "workflow.start"), state: literal(row["state"], "pending") };
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  const actual = Object.keys(row);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) fail();
  return row;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  return Object.fromEntries(Object.entries(value));
}
function array<T>(value: unknown, parse: (item: unknown) => T, max: number): readonly T[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value.map(parse);
}
function strings(value: unknown): readonly string[] { return array(value, text, MAX_ITEMS); }
function bool(value: unknown): boolean { if (typeof value !== "boolean") return fail(); return value; }
function digest(value: unknown): string { const parsed = text(value); if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) return fail(); return parsed; }
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}
function path(value: unknown): string {
  const parsed = text(value);
  if (!parsed.startsWith("/") || parsed.startsWith("//")) return fail();
  return parsed;
}
function time(value: unknown): string {
  const parsed = text(value);
  if (!TIME.test(parsed) || !Number.isFinite(Date.parse(parsed))) return fail();
  return parsed;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableTime(value: unknown): string | null { return value === null ? null : time(value); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail();
  return Number(value);
}
function literal<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) return fail();
  return expected;
}
function quality(value: unknown): ResourceQuality {
  const parsed = text(value);
  const found = QUALITY.find((item) => item === parsed);
  return found ?? fail();
}
function nullableRecord(value: unknown): DailyRun | null {
  if (value === null) return null;
  const row = exact(value, [
    "run_id", "loop_date", "phase", "state", "result_digest", "failure_code",
    "created_at", "updated_at",
  ]);
  text(row["run_id"]); text(row["loop_date"]); nullableText(row["phase"]); text(row["state"]);
  if (row["result_digest"] !== null) digest(row["result_digest"]);
  nullableText(row["failure_code"]); time(row["created_at"]); time(row["updated_at"]);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, item === null ? null : text(item)]));
}
function closeout(value: unknown): TodayResponse["latest_verified_closeout"] {
  if (value === null) return null;
  const row = exact(value, [
    "artifact_id", "run_id", "local_date", "generated_at", "canonical_digest",
    "verified_completion_count", "source_readiness",
  ]);
  return {
    artifact_id: text(row["artifact_id"]),
    run_id: text(row["run_id"]),
    local_date: text(row["local_date"]),
    generated_at: time(row["generated_at"]),
    canonical_digest: text(row["canonical_digest"]),
    verified_completion_count: integer(row["verified_completion_count"]),
    source_readiness: text(row["source_readiness"]),
  };
}
function safeLink(value: string): string {
  return value.startsWith("/api/v1/contexts/") && !value.startsWith("//") ? value : fail();
}
function apiError(
  kind: "offline" | "forbidden" | "not_found" | "server",
  code: string,
): DashboardApiError {
  return new DashboardApiError({
    kind,
    code,
    message: kind === "offline" ? "Dashboard unavailable" : "Validation error",
    request_id: "",
  });
}
function fail(): never { throw apiError("server", "VALIDATION_ERROR"); }
