import type { SessionResponse } from "./api.js";
import {
  booleanValue, closedArray, closedRecord, digest as closedDigest, integer as closedInteger,
  literal as closedLiteral, member, text as closedText, timestamp, validationFailure,
} from "./personal-closed.js";
import { parseHealthItem } from "./personal-health-parser.js";
import { requestPersonalJson } from "./personal-http.js";
import type { DashboardSurface } from "./surface.js";
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

const QUALITY = ["ready", "degraded", "no_data", "offline", "stale"] as const;
const CONFIDENCE = ["low", "medium", "high"] as const;
const DECISION_STATES = ["pending", "accepted", "rejected", "expired", "superseded"] as const;
const RECOMMENDATION_STATES = ["drafted", "parsed", "eligible", "abstained", "presented", "selected", "rejected", "expired"] as const;
const NOTIFICATION_STATES = ["created", "deferred", "ready", "delivering", "delivered", "suppressed", "failed", "expired"] as const;
const NOTIFICATION_URGENCIES = ["low", "normal", "high", "critical"] as const;
const NOTIFICATION_CHANNELS = ["in_app", "mac_native", "phone_web"] as const;
const FRESHNESS_STATES = ["fresh", "stale", "no_data", "unavailable", "offline"] as const;
const CITATION_KINDS = ["principle", "policy", "owner", "current", "deadline", "dependency", "stable_identity"] as const;
const EVIDENCE_KINDS = ["user_confirmed_principle", "owner_decision", "linux_live_fact", "context_observation", "confirmed_memory"] as const;
const ACTION_OPERATIONS = ["review", "continue_work", "execute"] as const;
const MAX_ITEMS = 100;
const ACCEPT_KEYS = ["schema_version", "recommendation_id", "action_rank", "request_id", "action", "state"] as const;

type SessionLoader = () => Promise<SessionResponse>;

export function createPersonalClient(loadSession: SessionLoader, surface: DashboardSurface = "local"): PersonalClient {
  /** The gateway requires the phone CSRF token on reads too; the local origin needs none. */
  const get = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (surface === "phone") headers["X-JARVIS-CSRF"] = (await loadSession()).csrf_token;
    return await requestPersonalJson(path, { headers, signal });
  };
  return {
    today: async (signal) => parseToday(await get("/api/v1/today", signal)),
    decisions: async (signal) => parsePage(await get("/api/v1/decision-inbox?limit=100", signal), "decision-inbox", parseDecision),
    notifications: async (signal) => parsePage(await get("/api/v1/notification-intents?limit=100", signal), "notification-intents", parseNotification),
    health: async (signal) => parsePage(await get("/api/v1/source-health?limit=100", signal), "source-health", parseHealthItem),
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

export function parseToday(value: unknown): TodayResponse {
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
    brief: { state: member(brief["state"], ["ready", "degraded", "no_data", "stale"] as const),
      brief_id: nullableText(brief["brief_id"]),
      generated_at: nullableTime(brief["generated_at"]), item_count: integer(brief["item_count"]) },
    active_decision_count: integer(row["active_decision_count"]),
    notification_summary: { total: integer(notifications["total"]), states: array(notifications["states"], (entry) => {
      const item = exact(entry, ["state", "count"]);
      return { state: member(item["state"], NOTIFICATION_STATES), count: integer(item["count"]) };
    }, MAX_ITEMS) },
    current_daily_run: nullableRecord(row["current_daily_run"]), last_daily_run: nullableRecord(row["last_daily_run"]),
    latest_verified_closeout: closeout(row["latest_verified_closeout"]), next_actions: actions,
    conflicts: strings(row["conflicts"]), omissions: strings(row["omissions"]),
    freshness: { state: member(freshness["state"], [...FRESHNESS_STATES, "expired"] as const),
      checked_at: nullableTime(freshness["checked_at"]),
      fresh_until: nullableTime(freshness["fresh_until"]) },
    deep_links: { decisions: path(links["decisions"]), daily_runs: path(links["daily_runs"]),
      notifications: path(links["notifications"]), source_health: path(links["source_health"]) },
  };
}

function parseTodayAction(value: unknown): TodayAction {
  const row = exact(value, ["recommendation_id", "rank", "title", "confidence_class", "expires_at", "deep_link"]);
  return { recommendation_id: text(row["recommendation_id"]), rank: integer(row["rank"]), title: text(row["title"]),
    confidence_class: member(row["confidence_class"], CONFIDENCE), expires_at: time(row["expires_at"]),
    deep_link: path(row["deep_link"]) };
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

export function parseDecision(value: unknown): DecisionItem {
  const row = exact(value, ["recommendation_id", "context_id", "rank", "title", "state", "confidence_class", "occurred_at",
    "expires_at", "evidence_digest", "identity_digest", "provenance_digest", "citations", "deep_link"]);
  digest(row["evidence_digest"]); digest(row["identity_digest"]); digest(row["provenance_digest"]);
  return { recommendation_id: text(row["recommendation_id"]), context_id: text(row["context_id"]), rank: integer(row["rank"]),
    title: text(row["title"]), state: member(row["state"], DECISION_STATES),
    confidence_class: member(row["confidence_class"], CONFIDENCE), occurred_at: time(row["occurred_at"]),
    expires_at: time(row["expires_at"]), citations: array(row["citations"], parseCitation, MAX_ITEMS),
    deep_link: path(row["deep_link"]) };
}

function parseCitation(value: unknown): Citation {
  const row = exact(value, ["context_evidence_id", "digest", "kind", "ref"]);
  return { context_evidence_id: nullableText(row["context_evidence_id"]), digest: digest(row["digest"]),
    kind: member(row["kind"], CITATION_KINDS), ref: text(row["ref"]) };
}

export function parseNotification(value: unknown): NotificationItem {
  const row = exact(value, ["intent_id", "correlation_id", "urgency", "channel", "preview", "deep_link", "state", "expires_at", "created_at", "updated_at"]);
  text(row["correlation_id"]); time(row["created_at"]);
  return { intent_id: text(row["intent_id"]), urgency: member(row["urgency"], NOTIFICATION_URGENCIES),
    channel: member(row["channel"], NOTIFICATION_CHANNELS), preview: text(row["preview"]),
    deep_link: path(row["deep_link"]), state: member(row["state"], NOTIFICATION_STATES),
    expires_at: time(row["expires_at"]), updated_at: time(row["updated_at"]) };
}

export function parseRecommendation(value: unknown): RecommendationDetail {
  const row = exact(value, ["schema_version", "resource", "recommendation_id", "context_id", "canonical_digest", "evidence_digest",
    "approval_requirement", "confidence_class", "lifecycle_state", "expires_at", "state", "actions", "evidence", "conflicts", "omissions", "deep_links"]);
  const links = exact(row["deep_links"], ["context_evidence"]); literal(row["resource"], "recommendation");
  digest(row["canonical_digest"]); digest(row["evidence_digest"]);
  member(row["approval_requirement"], ["none", "owner"] as const);
  array(row["actions"], parseRecommendationAction, 32);
  return { schema_version: literal(row["schema_version"], 1), recommendation_id: text(row["recommendation_id"]), context_id: text(row["context_id"]),
    confidence_class: member(row["confidence_class"], CONFIDENCE),
    lifecycle_state: member(row["lifecycle_state"], RECOMMENDATION_STATES), expires_at: time(row["expires_at"]),
    state: quality(row["state"]), evidence: array(row["evidence"], parseEvidenceItem, MAX_ITEMS), conflicts: strings(row["conflicts"]),
    omissions: strings(row["omissions"]), context_evidence_link: path(links["context_evidence"]) };
}

function parseRecommendationAction(value: unknown): void {
  const row = exact(value, ["rank", "title", "operation", "target_digest", "state", "owner_decision_required",
    "current", "occurred_at", "transition_digest"]);
  integer(row["rank"]); text(row["title"]); member(row["operation"], ACTION_OPERATIONS); digest(row["target_digest"]);
  member(row["state"], DECISION_STATES); bool(row["owner_decision_required"]); bool(row["current"]); time(row["occurred_at"]);
  if (row["transition_digest"] !== null) digest(row["transition_digest"]);
}

export function parseEvidence(value: unknown): ContextEvidence {
  const row = exact(value, [
    "schema_version", "resource", "context_id", "recommendation_id", "state",
    "freshness", "evidence", "conflicts", "omissions",
  ]);
  literal(row["resource"], "context-evidence");
  const freshness = exact(row["freshness"], ["state", "fresh_until"]);
  member(freshness["state"], FRESHNESS_STATES); time(freshness["fresh_until"]);
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
  return { evidence_id: text(row["evidence_id"]), source_id: text(row["source_id"]),
    kind: member(row["kind"], EVIDENCE_KINDS), digest: digest(row["digest"]),
    observed_at: time(row["observed_at"]), fresh_until: nullableTime(row["fresh_until"]) };
}
function parseAccepted(value: unknown): AcceptedAction {
  const row = exact(value, ACCEPT_KEYS);
  return { schema_version: literal(row["schema_version"], 1), recommendation_id: text(row["recommendation_id"]), action_rank: integer(row["action_rank"]),
    request_id: text(row["request_id"]), action: literal(row["action"], "workflow.start"), state: literal(row["state"], "pending") };
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { return closedRecord(value, keys); }
function array<T>(value: unknown, parse: (item: unknown) => T, max: number): readonly T[] {
  return closedArray(value, parse, max);
}
function strings(value: unknown): readonly string[] { return array(value, text, MAX_ITEMS); }
function bool(value: unknown): boolean { return booleanValue(value); }
function digest(value: unknown): string { return closedDigest(value); }
function text(value: unknown): string { return closedText(value); }
function path(value: unknown): string {
  const parsed = text(value);
  if (!parsed.startsWith("/") || parsed.startsWith("//")) return fail();
  return parsed;
}
function time(value: unknown): string { return timestamp(value); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableTime(value: unknown): string | null { return value === null ? null : time(value); }
function integer(value: unknown): number { return closedInteger(value); }
function literal<T extends string | number>(value: unknown, expected: T): T { return closedLiteral(value, expected); }
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
function fail(): never { return validationFailure(); }
