import type { ActionDelivery, AttemptExecution, Disposition } from "./state.js";
export type AttentionRow = {
  work_id: string; state: Disposition; received_at: string; source_at: string;
  last_successful_observation: string | null; warning: string | null;
  last_progress_received_at?: string | null; wait_started_at?: string | null;
  wait_reason?: string | null; wait_kind?: "user_decision" | "dependency" | "long_running" | "verification" | null;
  deadline_at?: string | null; impact?: number | null;
  attempt_execution?: AttemptExecution | null; action_delivery?: ActionDelivery | null;
  decision_valid?: number | null;
};
export type AttentionItem = {
  workId: string; disposition: Disposition; attemptExecution: AttemptExecution;
  actionDelivery: ActionDelivery; freshness: "fresh" | "unconfirmed";
  rank: 0 | 1 | 2 | 3 | null; reasons: string[]; waitReason: string | null;
  deadlineAt: string | null; impact: number | null; waitStartedAt: string | null;
  actionsEnabled: boolean;
};
const age = (timestamp: string | null | undefined, now: Date): number =>
  timestamp ? Math.max(0, now.getTime() - Date.parse(timestamp)) : Infinity;

export function evaluateAttention(row: AttentionRow, now: Date): AttentionItem {
  const freshness = age(row.last_successful_observation, now) >= 180_000 ? "unconfirmed" : "fresh";
  const terminal = row.state === "claimed_done" || row.state === "verified";
  const stalled = !terminal && age(row.last_progress_received_at === undefined ? row.received_at : row.last_progress_received_at, now) >= 600_000;
  const reasons: string[] = [];
  if (freshness === "unconfirmed" || row.warning) reasons.push("observation_gap");
  if (stalled) reasons.push("stall_suspected");
  if (row.state === "blocked" || row.state === "failed") reasons.push(row.state);
  if (row.state === "claimed_done" || row.wait_kind === "verification") reasons.push("verification_wait");
  const decision = row.wait_kind === "user_decision" && row.decision_valid === 1 && freshness === "fresh" && !row.warning && !terminal;
  if (decision) reasons.push("user_decision");
  const rank = decision ? 0 : row.state === "blocked" || row.state === "failed" ? 1
    : freshness === "unconfirmed" || row.warning || stalled ? 2
    : row.state === "claimed_done" || row.wait_kind === "verification" ? 3 : null;
  return {
    workId: row.work_id, disposition: row.state,
    attemptExecution: row.attempt_execution ?? (row.state === "running" ? "running" : row.state === "waiting" ? "waiting" : "unknown"),
    actionDelivery: row.action_delivery ?? "none", freshness, rank, reasons,
    waitReason: row.wait_reason ?? null, deadlineAt: row.deadline_at ?? null,
    impact: row.impact ?? null, waitStartedAt: row.wait_started_at ?? null,
    actionsEnabled: freshness === "fresh" && !row.warning && !terminal &&
      (row.action_delivery === undefined || row.action_delivery === null || row.action_delivery === "none" || row.action_delivery === "delivered"),
  };
}
const knownFirst = (a: number | null, b: number | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;
const timestamp = (value: string | null): number | null => value === null ? null : Date.parse(value);

export function attentionQueue(rows: readonly AttentionRow[], now: Date): AttentionItem[] {
  return rows.map(row => evaluateAttention(row, now)).filter(item => item.rank !== null)
    .sort((a, b) => (a.rank! - b.rank!) ||
      knownFirst(timestamp(a.deadlineAt), timestamp(b.deadlineAt)) ||
      (a.impact === null ? (b.impact === null ? 0 : 1) : b.impact === null ? -1 : b.impact - a.impact) ||
      knownFirst(timestamp(a.waitStartedAt), timestamp(b.waitStartedAt)) ||
      a.workId.localeCompare(b.workId));
}
