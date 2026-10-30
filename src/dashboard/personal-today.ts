import { NativeEveningStore } from "../evening-native-store.js";
import type { NativeEveningSourceConfig } from "../evening-native-source.js";
import type { TrustedCloseoutKey } from "../evening-closeout-types.js";
import type { AuthorityDb } from "../db.js";
import { assertDailyLoopIntegrity } from "../daily-loop-integrity.js";
import { kstLocalDate } from "../daily-loop-time.js";
import { recommendationsWithUnavailableLocalSource } from "../local-observation-availability.js";
import { recommendationsWithClosedMemorySource } from "../personal-memory-availability.js";
import { verifyMorningBriefResult } from "../morning-brief-artifact.js";
import { MemoryProjectionAuthority } from "../memory-projection-authority.js";
import { verifyEveningCloseoutArtifact } from "../evening-closeout-artifact.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "../personal-validation.js";
import { Recommendations } from "../recommendations.js";
import { dbRow, dbRows, nullableText, readOnlySnapshot, text } from "./personal-db.js";

type BriefSummary = { readonly state: string; readonly brief_id: string | null; readonly generated_at: string | null; readonly item_count: number };

export function todayProjection(db: AuthorityDb, now: Date, closeoutKey?: TrustedCloseoutKey,
  nativeConfig?: NativeEveningSourceConfig): Readonly<Record<string, unknown>> {
  return readOnlySnapshot(db, () => {
    const recommendation = new Recommendations(db).project(now.toISOString(), 500);
    const projections = new MemoryProjectionAuthority(db);
    const runs = projections.visible(dbRows(db.db.prepare(
      `SELECT run_id,loop_date,phase,state,result_digest,failure_code,created_at,updated_at
       FROM daily_loop_runs WHERE record_version=1 ORDER BY loop_date DESC, CASE phase WHEN 'evening' THEN 1 WHEN 'morning' THEN 0 ELSE -1 END DESC, created_at DESC, run_id DESC`,
    ).all()), row => ({ kind: "daily_run", id: text(row, "run_id"),
      component_id: text(row, "run_id") })).slice(0, 2);
    const visibleNotifications = projections.visible(dbRows(db.db.prepare(
      "SELECT intent_id,state FROM notification_intents ORDER BY intent_id",
    ).all()), row => ({ kind: "notification_intent", id: text(row, "intent_id"),
      component_id: text(row, "intent_id") }));
    const notificationCounts = new Map<string, number>();
    for (const row of visibleNotifications) {
      const state = text(row, "state");
      notificationCounts.set(state, (notificationCounts.get(state) ?? 0) + 1);
    }
    const notifications = [...notificationCounts].sort(([left], [right]) => left.localeCompare(right))
      .map(([state, count]) => ({ state, count }));
    const context = latestContext(db, now);
    const brief = latestBrief(db, now);
    const closeout = latestCloseout(db, now, closeoutKey, nativeConfig);
    const current = runs[0];
    return {
      schema_version: 1, resource: "today", generated_at: now.toISOString(),
      state: context.state === "ready" || recommendation.next_actions.length > 0 ? "ready" : context.state,
      brief, active_decision_count: recommendation.owner_decisions_needed.length,
      notification_summary: { total: notifications.reduce((sum, item) => sum + item.count, 0), states: notifications },
      current_daily_run: current === undefined ? null : runSummary(current),
      last_daily_run: runs[1] === undefined ? null : runSummary(runs[1]), latest_verified_closeout: closeout,
      next_actions: recommendation.next_actions.slice(0, 3).map((action) => ({ recommendation_id: action.recommendation_id,
        rank: action.rank, title: action.title, confidence_class: action.confidence_class, expires_at: action.expires_at,
        deep_link: `/recommendations/${encodeURIComponent(action.recommendation_id)}` })),
      conflicts: recommendation.conflicts, omissions: [...new Set([...recommendation.omissions, ...context.omissions])].sort(),
      freshness: context.freshness,
      deep_links: { decisions: "/api/v1/decision-inbox", daily_runs: "/api/v1/daily-runs",
        notifications: "/api/v1/notification-intents", source_health: "/api/v1/source-health" },
    };
  });
}

function latestContext(db: AuthorityDb, now: Date): { readonly state: string; readonly freshness: unknown; readonly omissions: readonly string[] } {
  const raw = db.db.prepare(
    `SELECT context_id,canonical_digest,canonical_envelope_json FROM personal_context_snapshots
     ORDER BY created_at DESC,context_id DESC LIMIT 1`,
  ).get();
  if (raw === undefined) return { state: "no_data", freshness: { state: "no_data", checked_at: null, fresh_until: null }, omissions: ["context_no_data"] };
  const row = dbRow(raw);
  const contextId = text(row, "context_id");
  if (new MemoryProjectionAuthority(db).isSuppressed({
    kind: "context", id: contextId, component_id: contextId,
  })) return { state: "no_data", freshness: { state: "no_data", checked_at: null, fresh_until: null },
    omissions: ["memory_suppressed"] };
  const context = parseContextSnapshotV1(JSON.parse(text(row, "canonical_envelope_json")));
  if (canonicalPersonalContractHash(context) !== text(row, "canonical_digest")) throw new PersonalTodayIntegrityError();
  const timestamp = now.toISOString();
  const future = context.created_at > timestamp || context.valid_at > timestamp || context.freshness.checked_at > timestamp;
  const state = future ? "no_data" : timestamp >= context.expires_at ? "expired"
    : context.freshness.state === "fresh" && timestamp >= context.freshness.fresh_until ? "stale" : context.freshness.state;
  return { state: state === "fresh" ? "ready" : state === "expired" ? "stale" : state,
    freshness: { ...context.freshness, state }, omissions: context.payload.omissions };
}

function latestBrief(db: AuthorityDb, now: Date): BriefSummary {
  const raw = db.db.prepare(
    `SELECT s.step_id,s.run_id,s.detail_json,r.loop_date,r.phase FROM daily_loop_steps s
     JOIN daily_loop_runs r ON r.run_id=s.run_id
     WHERE s.step_key='morning_reconcile' AND s.state='completed'
     ORDER BY r.loop_date DESC,r.run_id DESC LIMIT 1`,
  ).get();
  if (raw === undefined) return { state: "no_data", brief_id: null, generated_at: null, item_count: 0 };
  const row = dbRow(raw);
  const projections = new MemoryProjectionAuthority(db);
  if (projections.isProjectionIdSuppressed(text(row, "step_id"))
    || projections.isProjectionIdSuppressed(text(row, "run_id"))) {
    return { state: "no_data", brief_id: null, generated_at: null, item_count: 0 };
  }
  const parsed: unknown = JSON.parse(text(row, "detail_json"));
  assertDailyLoopIntegrity(db, text(row, "run_id"));
  if (record(parsed) && Object.keys(parsed).sort().join(",") === "boundary,step_key"
    && parsed["boundary"] === "no_external_effect" && parsed["step_key"] === "morning_reconcile") {
    return { state: "no_data", brief_id: null, generated_at: null, item_count: 0 };
  }
  const brief = verifyMorningBriefResult(parsed);
  if (text(row, "phase") !== "morning" || kstLocalDate(new Date(brief.generated_at)) !== text(row, "loop_date")) {
    throw new PersonalTodayIntegrityError();
  }
  const timestamp = now.toISOString(); const items = [...brief.needs_you_first, ...brief.waiting, ...brief.fyi];
  if (brief.generated_at > timestamp || items.some(item => item.valid_from > timestamp || item.observed_at > timestamp)) {
    return { state: "no_data", brief_id: null, generated_at: null, item_count: 0 };
  }
  const currentDay = kstLocalDate(now) === text(row, "loop_date");
  // A published brief stays readable, but items whose source no longer stands are not current. A
  // local observation that no longer matches is one way that happens; the owner hiding the task a
  // derived memory came from is the other, and the projection already withdraws the work for it. A
  // brief that kept offering the item would be telling the owner something the rest of the product
  // has stopped believing.
  const contributing = items.flatMap(item => item.contributing_recommendation_ids);
  const unavailable = recommendationsWithUnavailableLocalSource(db.db, contributing, timestamp);
  const closed = recommendationsWithClosedMemorySource(db, contributing);
  const currentItems = currentDay ? items.filter(item => timestamp < item.fresh_until && timestamp < item.valid_until
    && item.contributing_recommendation_ids.every(id => !unavailable.has(id) && !closed.has(id))) : [];
  const stale = !currentDay || currentItems.length !== items.length;
  return { state: stale ? "stale" : brief.context_readiness, brief_id: brief.brief_id,
    generated_at: brief.generated_at, item_count: currentItems.length };
}

function latestCloseout(db: AuthorityDb, now: Date, trusted?: TrustedCloseoutKey,
  nativeConfig?: NativeEveningSourceConfig): Readonly<Record<string, unknown>> | null {
  if (trusted === undefined) return null;
  const raw = db.db.prepare(
    `SELECT s.step_id,s.run_id,s.detail_json,r.loop_date,r.correlation_id,r.phase,r.state AS run_state,r.updated_at FROM daily_loop_steps s
     JOIN daily_loop_runs r ON r.run_id=s.run_id
     WHERE s.step_key='evening_summary' AND s.state='completed'
     ORDER BY r.loop_date DESC,r.run_id DESC LIMIT 1`,
  ).get();
  if (raw === undefined) return null;
  const row = dbRow(raw);
  const projections = new MemoryProjectionAuthority(db);
  if (projections.isProjectionIdSuppressed(text(row, "step_id"))
    || projections.isProjectionIdSuppressed(text(row, "run_id"))) return null;
  const parsed: unknown = JSON.parse(text(row, "detail_json"));
  if (record(parsed) && parsed["schema_version"] === 2) {
    if (nativeConfig === undefined) return null;
    const artifact = new NativeEveningStore(db, trusted, nativeConfig, () => now).read(text(row, "run_id"));
    return { artifact_id: artifact.artifact_id, run_id: artifact.run_id, local_date: artifact.local_date,
      generated_at: artifact.generated_at, canonical_digest: artifact.canonical_digest,
      verified_completion_count: artifact.native_completion_count, source_readiness: artifact.source_readiness };
  }
  const artifact = verifyEveningCloseoutArtifact(parsed, trusted);
  assertDailyLoopIntegrity(db, text(row, "run_id"));
  if (artifact.run_id !== text(row, "run_id") || artifact.local_date !== text(row, "loop_date")
    || artifact.correlation_id !== text(row, "correlation_id") || text(row, "phase") !== "evening") {
    throw new PersonalTodayIntegrityError();
  }
  if (text(row, "run_state") !== "completed" || artifact.generated_at > now.toISOString()
    || text(row, "updated_at") > now.toISOString() || projections.isProjectionIdSuppressed(artifact.artifact_id)) return null;
  return { artifact_id: artifact.artifact_id, run_id: artifact.run_id, local_date: artifact.local_date,
    generated_at: artifact.generated_at, canonical_digest: artifact.canonical_digest,
    verified_completion_count: artifact.verified_completions.length, source_readiness: artifact.source_readiness };
}

function runSummary(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { run_id: text(row, "run_id"), loop_date: text(row, "loop_date"), phase: nullableText(row, "phase"),
    state: text(row, "state"), result_digest: nullableText(row, "result_digest"), failure_code: nullableText(row, "failure_code"),
    created_at: text(row, "created_at"), updated_at: text(row, "updated_at") };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PersonalTodayIntegrityError extends Error {
  readonly name = "PersonalTodayIntegrityError";
  constructor() { super("PERSONAL_TODAY_INTEGRITY_FAILURE"); }
}
