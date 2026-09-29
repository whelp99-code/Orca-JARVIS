import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { evaluateRefreshContext, kstInstant, kstLocalDate } from "./daily-loop-time.js";
import type { MorningBriefResult } from "./morning-brief-types.js";
import type { MorningRecommendationLineage } from "./morning-recommendation-source.js";
import { NotificationIntentStore } from "./notification-intent-store.js";
import type { OwnerDecisionQueueEntry } from "./notification-intent-types.js";
import { currentStateFromDoctor } from "./state-projection.js";

export const CITED_ACTION_CAP = 3;

const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export type MorningAssemblyOptions = {
  readonly subscribedAt?: Date;
  readonly freshnessMs?: number;
};

export type MorningOperatingBrief = {
  readonly refresh_subscription: "before_07:00" | "late";
  readonly context_readiness: "ready" | "degraded" | "no_data";
  readonly degradation_reasons: readonly string[];
  readonly sections: {
    readonly now: Record<string, unknown>;
    readonly blocked: readonly unknown[];
    readonly decisions: readonly unknown[];
    readonly next_3: readonly unknown[];
    readonly workers: readonly unknown[];
    readonly risks: readonly unknown[];
  };
  readonly canonical_digest: string;
};

export function beforeMorningAssemblyDeadline(at: Date): boolean {
  return at.getTime() < kstInstant(kstLocalDate(at), 7, 20).getTime();
}

export type MorningHoldClock = (() => Date) & { readonly wait: (ms: number) => Promise<void> };

/** The oneshot waits on this clock. A caller-supplied `wait` moves virtual time; a live clock sleeps. */
export function bindMorningHold(clock: () => Date, live: boolean): MorningHoldClock {
  const provided = Reflect.get(clock, "wait");
  if (typeof provided === "function") {
    return Object.assign(() => clock(), { wait: (ms: number) => Reflect.apply(provided, clock, [ms]) as Promise<void> });
  }
  if (live) return Object.assign(clock, { wait: (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }) });
  return Object.assign(() => clock(), { wait: () => Promise.resolve() });
}

/** First observation of the local date wins, so a later 07:15 cycle cannot move an earlier subscription. */
export function installMorningRefreshSubscription(authority: AuthorityDb, at: Date): Date {
  const date = kstLocalDate(at);
  authority.db.prepare(
    "INSERT INTO morning_refresh_subscriptions(local_date, subscribed_at) VALUES (?, ?) ON CONFLICT(local_date) DO NOTHING",
  ).run(date, at.toISOString());
  return morningRefreshSubscription(authority, at) ?? at;
}

export function morningRefreshSubscription(authority: AuthorityDb, at: Date): Date | undefined {
  const row = authority.db.prepare(
    "SELECT subscribed_at FROM morning_refresh_subscriptions WHERE local_date=?",
  ).get(kstLocalDate(at)) as { subscribed_at: string } | undefined;
  return row === undefined ? undefined : new Date(row.subscribed_at);
}

export function persistMorningOperatingBrief(authority: AuthorityDb, briefId: string, operations: MorningOperatingBrief): void {
  authority.db.prepare(
    "INSERT INTO morning_operating_publications(brief_id, operations_json) VALUES (?, ?)",
  ).run(briefId, JSON.stringify(operations));
}

export function loadMorningOperatingBrief(authority: AuthorityDb, briefId: string): MorningOperatingBrief | null {
  const row = authority.db.prepare(
    "SELECT operations_json FROM morning_operating_publications WHERE brief_id=?",
  ).get(briefId) as { operations_json: string } | undefined;
  if (row === undefined) return null;
  return JSON.parse(row.operations_json) as MorningOperatingBrief;
}

export function refreshSubscriptionOnTime(subscribedAt: Date, at: Date): boolean {
  return subscribedAt.getTime() < kstInstant(kstLocalDate(at), 7, 0).getTime();
}

function completedDate(refreshValue: unknown): string | null {
  if (refreshValue === null || typeof refreshValue !== "object" || Array.isArray(refreshValue)) return null;
  const completed = Reflect.get(refreshValue, "completed_at");
  return typeof completed === "string" ? completed : null;
}

export function morningRefreshReasons(at: Date, refreshValue: unknown, freshnessMs: number, subscriptionOnTime: boolean): readonly string[] {
  const context = evaluateRefreshContext(refreshValue ?? null, at, freshnessMs);
  const reasons: string[] = [];
  const completed = completedDate(refreshValue);
  if (completed !== null && kstLocalDate(new Date(completed)) !== kstLocalDate(at)) reasons.push("refresh_previous_date");
  if (context.state === "no_data") reasons.push("no_data");
  else if (context.reason !== "refresh_fresh" || reasons.includes("refresh_previous_date")) reasons.push(context.reason);
  if (!subscriptionOnTime) reasons.push("refresh_subscription_late");
  return reasons;
}

export function citedMorningOperations(authority: AuthorityDb, brief: MorningBriefResult, at: Date,
  reasons: readonly string[], subscriptionOnTime: boolean): MorningOperatingBrief {
  const projection = currentStateFromDoctor(authority, {
    ok: false,
    checks: reasons.map(reason => ({ name: "morning_refresh", ok: false, code: reason, actual: reason })),
  }, at);
  const cited = [...brief.needs_you_first, ...brief.waiting, ...brief.fyi].slice(0, CITED_ACTION_CAP);
  const readiness: MorningOperatingBrief["context_readiness"] = reasons.length === 0 ? "ready"
    : reasons.length === 1 && reasons[0] === "no_data" ? "no_data" : "degraded";
  const sections = {
    now: { ...projection.now, refresh_reasons: reasons },
    blocked: projection.blocked,
    decisions: projection.decisions,
    next_3: (cited.length > 0 ? cited : projection.next_3).slice(0, CITED_ACTION_CAP),
    workers: projection.workers,
    risks: [...projection.risks, ...reasons.map(reason => ({ name: "morning_refresh", code: reason }))],
  };
  const core = {
    refresh_subscription: subscriptionOnTime ? "before_07:00" as const : "late" as const,
    context_readiness: readiness,
    degradation_reasons: [...reasons].sort(),
    sections,
  };
  return { ...core, canonical_digest: hash(JSON.parse(JSON.stringify(core))) };
}

function citedEntry(brief: MorningBriefResult, lineage: readonly MorningRecommendationLineage[], now: string): OwnerDecisionQueueEntry {
  const item = [...brief.needs_you_first, ...brief.waiting, ...brief.fyi].find(value => value.owner_decision_required);
  const link = item === undefined ? undefined : lineage.find(value => value.recommendation_id === item.recommendation_id && value.action_id === item.action_id);
  const recommendationId = link?.recommendation_id ?? brief.brief_id;
  const actionId = link?.action_id ?? "none";
  const contextId = link?.context_id ?? brief.brief_id;
  const identity = link?.identity_digest ?? brief.canonical_digest;
  const expiresAt = item !== undefined && item.valid_until > now ? item.valid_until : new Date(Date.parse(now) + 3_600_000).toISOString();
  const semantic = { brief_id: brief.brief_id, recommendation_id: recommendationId, action_id: actionId };
  const semanticDigest = hash(semantic);
  const key = hash({ semantic_key: semanticDigest });
  return {
    queue_key: `decision:v1:${key}`, dedup_key: `notification:v1:${key}`, thread_key: `decision-thread:v1:${hash({ recommendation_id: recommendationId })}`,
    semantic_key: semanticDigest, category: "owner_decision", resource_id: `decision:v1:${key}`, urgency: "digest",
    title: "Morning operating brief", preview: "Review the cited morning operating brief.",
    deep_link: `/today/${hash({ brief_id: brief.brief_id })}`, recommendation_id: recommendationId, action_id: actionId,
    context_id: contextId, context_digest: hash(contextId), recommendation_digest: brief.canonical_digest,
    evidence_digest: item?.provenance_digest ?? brief.canonical_digest, identity_digest: identity,
    provenance_digest: item?.provenance_digest ?? brief.canonical_digest, contributing_recommendation_ids: link === undefined ? [] : [link.recommendation_id],
    contributing_action_ids: link === undefined ? [] : [link.action_id], contributing_context_ids: link === undefined ? [] : [link.context_id],
    contributing_evidence_digests: [item?.provenance_digest ?? brief.canonical_digest], contributing_identity_digests: [identity],
    contributing_provenance_digests: [item?.provenance_digest ?? brief.canonical_digest], source_ids: item?.source_ids ?? [],
    citations: [], created_at: now, occurred_at: now, expires_at: expiresAt, deadline: item?.deadline ?? null,
    confidence: item?.confidence ?? "low", reversible: true, safety: "standard",
    priority: item?.priority ?? { owner_safety_gate: "pass", customer_impact: "internal", deadline_bucket: "none",
      dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: brief.brief_id },
    state: "needs_owner", semantic_digest: semanticDigest,
  };
}

/** One redacted intent for the published brief. It does not stage work and does not claim an unconfirmed decision is confirmed. */
export function persistCitedNotification(authority: AuthorityDb, brief: MorningBriefResult,
  lineage: readonly MorningRecommendationLineage[], now: string): void {
  new NotificationIntentStore(authority).persist(citedEntry(brief, lineage, now), now);
}
