import type { AuthorityDb } from "../db.js";
import { assertDailyLoopIntegrity } from "../daily-loop-integrity.js";
import { kstLocalDate } from "../daily-loop-time.js";
import { verifyMorningBriefResult } from "../morning-brief-artifact.js";
import { MemoryProjectionAuthority } from "../memory-projection-authority.js";
import { verifyEveningCloseoutArtifact } from "../evening-closeout-artifact.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "../personal-validation.js";
import { Recommendations } from "../recommendations.js";
import { dbRow, dbRows, nullableText, readOnlySnapshot, text } from "./personal-db.js";

type BriefSummary = { readonly state: string; readonly brief_id: string | null; readonly generated_at: string | null; readonly item_count: number };

export function todayProjection(db: AuthorityDb, now: Date): Readonly<Record<string, unknown>> {
  return readOnlySnapshot(db, () => {
    const recommendation = new Recommendations(db).project(now.toISOString(), 500);
    const projections = new MemoryProjectionAuthority(db);
    const runs = projections.visible(dbRows(db.db.prepare(
      `SELECT run_id,loop_date,phase,state,result_digest,failure_code,created_at,updated_at
       FROM daily_loop_runs WHERE record_version=1 ORDER BY updated_at DESC,run_id DESC`,
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
    const brief = latestBrief(db);
    const closeout = latestCloseout(db);
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
  const state = context.freshness.state === "fresh" && now.toISOString() >= context.freshness.fresh_until ? "stale" : context.freshness.state;
  return { state: state === "fresh" ? "ready" : state, freshness: context.freshness, omissions: context.payload.omissions };
}

function latestBrief(db: AuthorityDb): BriefSummary {
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
  const itemCount = brief.needs_you_first.length + brief.waiting.length + brief.fyi.length;
  return { state: brief.context_readiness, brief_id: brief.brief_id, generated_at: brief.generated_at, item_count: itemCount };
}

function latestCloseout(db: AuthorityDb): Readonly<Record<string, unknown>> | null {
  const raw = db.db.prepare(
    `SELECT s.step_id,s.run_id,s.detail_json FROM daily_loop_steps s
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
  if (!record(parsed) || !record(parsed["envelope"]) || typeof parsed["envelope"]["key_id"] !== "string"
    || typeof parsed["envelope"]["public_key_spki"] !== "string") throw new PersonalTodayIntegrityError();
  const artifact = verifyEveningCloseoutArtifact(parsed, {
    key_id: parsed["envelope"]["key_id"], public_key_spki: parsed["envelope"]["public_key_spki"],
  });
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
