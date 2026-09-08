import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { parseDailyLoopDate } from "./daily-loop-input.js";
import { DailyLoopError, type DailyLoopBudgets, type DailyLoopFailureCode } from "./daily-loop-types.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { verifyMorningBriefResult } from "./morning-brief-artifact.js";
import { verifyEveningCloseoutArtifact } from "./evening-closeout-artifact.js";
import type { TrustedCloseoutKey } from "./evening-closeout-types.js";
import { verifyNativeEveningEnvelope } from "./evening-native-envelope.js";

type UsageRun = { run_id: string; record_version: number; correlation_id: string; phase: string };

export class DailyBudgetExceeded extends Error {
  constructor(readonly code: DailyLoopFailureCode) { super(code); }
}

export type DailyLoopUsage = { readonly items: number; readonly work: number; readonly bytes: number };
const invalid = (): never => { throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE"); };

/** Completed output usage, including suppressed outputs. This is not token or CPU accounting. */
export function dailyLoopUsage(authority: AuthorityDb, dateValue: unknown, closeoutKey?: TrustedCloseoutKey): DailyLoopUsage {
  const date = parseDailyLoopDate(dateValue);
  return authority.db.transaction(() => {
    const runs = authority.db.prepare("SELECT run_id,record_version,correlation_id,phase FROM daily_loop_runs WHERE loop_date=? ORDER BY run_id")
      .all(date) as UsageRun[];
    const total = { items: 0, work: 0, bytes: 0 };
    for (const run of runs) {
      assertDailyLoopIntegrity(authority, run.run_id);
      const steps = authority.db.prepare("SELECT step_key,state,detail_json FROM daily_loop_steps WHERE run_id=? ORDER BY sequence")
        .all(run.run_id) as { step_key: string; state: string; detail_json: string | null }[];
      for (const step of steps) {
        if (step.state === "pending") continue;
        if (step.state !== "completed" || run.record_version !== 1 || step.detail_json === null) return invalid();
        const cost = completedDailyStepCost(step.step_key, step.detail_json, date, run, closeoutKey);
        total.items += cost.items; total.work += cost.work; total.bytes += cost.bytes;
        if (Object.values(total).some(value => !Number.isSafeInteger(value))) return invalid();
      }
    }
    return total;
  }).deferred();
}

function completedDailyStepCost(key: string, json: string, date: string, run: UsageRun, closeoutKey?: TrustedCloseoutKey): DailyLoopUsage {
  const detail: unknown = JSON.parse(json);
  if (canonicalize(detail) !== json) return invalid();
  const bytes = Buffer.byteLength(json);
  if (key === "evening_summary") {
    if (closeoutKey === undefined || run.phase !== "evening") return invalid();
    try {
      if (typeof detail === "object" && detail !== null && "schema_version" in detail && detail.schema_version === 2) {
        const artifact = verifyNativeEveningEnvelope(detail, closeoutKey);
        if (artifact.run_id !== run.run_id || artifact.correlation_id !== run.correlation_id || artifact.local_date !== date) return invalid();
        return { items: artifact.native_completion_count, work: 1, bytes };
      }
      const artifact = verifyEveningCloseoutArtifact(detail, closeoutKey);
      if (artifact.run_id !== run.run_id || artifact.correlation_id !== run.correlation_id || artifact.local_date !== date) return invalid();
      const items = artifact.verified_completions.length + artifact.open_or_failed.length
        + artifact.decisions_made.length + artifact.owner_decisions_required.length + artifact.unresolved_risks.length
        + artifact.memory_candidate_support.length + (artifact.tomorrow_first_action === "none" ? 0 : 1);
      return { items, work: 1, bytes };
    } catch { return invalid(); }
  }
  if (key === "morning_reconcile") {
    const brief = verifyMorningBriefResult(detail);
    if (kstLocalDate(new Date(brief.generated_at)) !== date) return invalid();
    return { items: brief.needs_you_first.length + brief.waiting.length + brief.fyi.length, work: 1, bytes };
  }
  if (key !== "refresh_context" || typeof detail !== "object" || detail === null || Array.isArray(detail)) return invalid();
  const row = detail as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "reason,refresh_id,state") return invalid();
  const missing = row["state"] === "no_data" && row["reason"] === "refresh_missing" && row["refresh_id"] === null;
  const invalidRefresh = row["state"] === "degraded" && row["reason"] === "refresh_invalid" && row["refresh_id"] === null;
  const identified = typeof row["refresh_id"] === "string" && row["refresh_id"].length > 0 && (
    (row["state"] === "ready" && row["reason"] === "refresh_fresh") || (row["state"] === "degraded"
      && ["refresh_failed", "refresh_stale", "refresh_incompatible", "refresh_capped"].includes(String(row["reason"]))));
  if (!missing && !invalidRefresh && !identified) return invalid();
  return { items: 1, work: 1, bytes };
}

export function dailyUsageExhausted(used: DailyLoopUsage, budgets: DailyLoopBudgets): DailyLoopFailureCode | null {
  if (used.items > budgets.max_items) return "BUDGET_ITEMS_EXHAUSTED";
  if (used.work > budgets.max_work) return "BUDGET_WORK_EXHAUSTED";
  return used.bytes > budgets.max_bytes ? "BUDGET_BYTES_EXHAUSTED" : null;
}
