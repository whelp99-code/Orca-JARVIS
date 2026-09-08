import { JarvisError, type AuthorityDb } from "./db.js";
import { readTaskProviderUsage, type TaskUsageAttempt } from "./task-provider-usage.js";

/** Costs of all attempted calls in the request cohort, including failed work.
 * Partial observations are never divided into a purported full cost per success. */
export function readTaskUsagePerformance(authority: AuthorityDb, from: string, to: string,
  observedAt: Date, verifiedCompletions: number, invalidCompletionEvidence: number) {
  const attempts = authority.db.prepare(`SELECT a.* FROM control_effect_attempts a
    JOIN control_command_requests r ON r.request_id=a.request_id
    WHERE r.action='task.execute' AND r.requested_at>=? AND r.requested_at<?
      AND a.effect_type='task.execute' AND a.task_run_id IS NOT NULL AND a.state<>'prepared'
    ORDER BY a.attempt_id LIMIT 1001`).all(from, to) as TaskUsageAttempt[];
  if (attempts.length > 1000) throw new JarvisError("TASK_PERFORMANCE_COHORT_LIMIT");
  let reported = 0, missing = 0, invalid = 0, total = 0;
  for (const attempt of attempts) {
    try {
      const observed = readTaskProviderUsage(authority, attempt, observedAt);
      if (!observed) { missing++; continue; }
      if (observed.status === "unavailable") {
        if (observed.reason === "metadata_invalid") invalid++; else missing++;
        continue;
      }
      const cost = observed.usage.estimated_cost;
      if (cost.status !== "reported") {
        if (cost.status === "invalid") invalid++; else missing++;
        continue;
      }
      reported++;
      total += cost.usd;
    } catch (error) {
      if (!(error instanceof JarvisError) || error.code !== "TASK_USAGE_EVIDENCE_INVALID") throw error;
      invalid++;
    }
  }
  const finite = Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER;
  const complete = attempts.length > 0 && missing === 0 && invalid === 0 && finite
    && verifiedCompletions <= attempts.length && invalidCompletionEvidence === 0;
  return { source: "claude_result", kind: "client_estimate", currency: "USD", attempts: attempts.length,
    reported_estimates: reported, missing_estimates: missing, invalid_estimates: invalid,
    observed_estimated_usd: reported > 0 && finite ? total : null,
    verified_completions: verifiedCompletions,
    estimated_usd_per_verified_completion: complete && verifiedCompletions > 0 ? total / verifiedCompletions : null,
    status: !finite ? "aggregate_overflow" : invalidCompletionEvidence ? "invalid_completion_evidence"
      : !attempts.length ? "no_attempts" : !complete ? "incomplete_observations"
        : !verifiedCompletions ? "no_verified_completions" : "estimated",
    billing_verified: false, policy_promoted: false };
}
