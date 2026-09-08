import { JarvisError, type AuthorityDb } from "./db.js";
import { candidateInstant } from "./task-candidate-artifact-codec.js";
import { readTaskCompletionEvidence } from "./task-completion-evidence.js";

const MAX_REQUESTS = 1000;
const states = ["pending", "approved", "rejected", "claimed", "completed", "failed", "uncertain", "cancelled"] as const;
type State = typeof states[number];
type Row = { request_id: string; state: State; requested_at: string; decision: string | null; accepted_at: string | null };

export function taskPerformanceWindow(from: unknown, to: unknown, observedAt: Date) {
  if (!candidateInstant(from) || !candidateInstant(to) || !Number.isFinite(observedAt.getTime())
    || from >= to || to > observedAt.toISOString()) throw new JarvisError("TASK_PERFORMANCE_WINDOW_INVALID");
  return { from, to, observed_at: observedAt.toISOString() };
}

function distribution(samples: number[], invalid: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { unit: "ms", samples: sorted.length, invalid_samples: invalid,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1]! : null,
    max: sorted.length ? sorted[sorted.length - 1]! : null };
}

/** Current-state cohort metrics; historical verification grants no new execution authority. */
export function readTaskPerformance(authority: AuthorityDb, from: unknown, to: unknown, observedAt = new Date()) {
  const window = taskPerformanceWindow(from, to, observedAt);
  return authority.db.transaction(() => {
    const rows = authority.db.prepare(`SELECT r.request_id,r.state,r.requested_at,c.decision,c.created_at AS accepted_at
      FROM control_command_requests r LEFT JOIN control_command_receipts c ON c.request_id=r.request_id
      WHERE r.action='task.execute' AND r.requested_at>=? AND r.requested_at<?
      ORDER BY r.requested_at,r.request_id LIMIT ?`).all(window.from, window.to, MAX_REQUESTS + 1) as Row[];
    if (rows.length > MAX_REQUESTS) throw new JarvisError("TASK_PERFORMANCE_COHORT_LIMIT");
    const counts = Object.fromEntries(states.map(state => [state, 0])) as Record<State, number>;
    const waits: number[] = [], openAges: number[] = [], completions: number[] = [];
    let verified = 0, invalidEvidence = 0, invalidWaits = 0, invalidCompletions = 0;
    for (const row of rows) {
      if (!states.includes(row.state) || !candidateInstant(row.requested_at)) throw new JarvisError("TASK_PERFORMANCE_RECORD_INVALID");
      counts[row.state]++;
      const requested = Date.parse(row.requested_at);
      if (row.decision === "approve") {
        if (!candidateInstant(row.accepted_at) || row.accepted_at < row.requested_at || row.accepted_at > window.observed_at) invalidWaits++;
        else waits.push(Date.parse(row.accepted_at) - requested);
      } else if (row.state === "pending" && row.accepted_at === null) openAges.push(observedAt.getTime() - requested);
      if (row.state !== "completed") continue;
      try {
        const evidence = readTaskCompletionEvidence(authority, row.request_id, observedAt);
        if (!evidence) { invalidEvidence++; continue; }
        const completed = Date.parse(evidence.completion.completed_at);
        if (completed < requested) { invalidCompletions++; invalidEvidence++; continue; }
        verified++;
        completions.push(completed - requested);
      } catch (error) {
        if (!(error instanceof JarvisError) || error.code !== "TASK_COMPLETION_INVALID") throw error;
        invalidEvidence++;
      }
    }
    const terminal = counts.completed + counts.failed;
    return { schema_version: 1, scope: "task.execute_request_cohort", window,
      observation: "current_snapshot", requests: rows.length, states: counts,
      verified_completions: verified, unverified_completed_requests: invalidEvidence,
      terminal_success: { numerator: verified, denominator: terminal,
        ratio: terminal > 0 && invalidEvidence === 0 ? verified / terminal : null,
        status: invalidEvidence ? "invalid_completion_evidence" : terminal ? "measured" : "no_terminal_requests" },
      approval_wait: distribution(waits, invalidWaits), open_approval_age: distribution(openAges, 0),
      completion_latency: distribution(completions, invalidCompletions),
      unavailable: { cost_per_success: "billing_usage_not_recorded", rework: "business_task_lineage_not_recorded",
        duplicate_external_effects: "external_effect_observation_not_recorded", shadow_comparison: "comparison_contract_not_recorded" },
      policy_promoted: false };
  }).deferred();
}
