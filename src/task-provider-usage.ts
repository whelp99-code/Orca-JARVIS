import { canonicalize } from "./canonical.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { controlValueDigest } from "./control-plane-contract.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { readClaudeTaskUsage, type ClaudeTaskUsage } from "./claude-task-usage.js";
import { candidateInstant } from "./task-candidate-artifact-codec.js";

const TYPE = "task.provider.usage.observed";
const SOURCE = "task-provider";
export const taskUsageEventId = (attemptId: string) => `evt:task-provider-usage:${attemptId}`;
type Observation = { readonly status: "observed"; readonly usage: ClaudeTaskUsage }
  | { readonly status: "unavailable"; readonly reason: "provider_result_unavailable" | "metadata_missing" | "metadata_invalid" };
export type TaskUsageAttempt = {
  attempt_id: string; request_id: string; receipt_id: string; lease_fence: number;
  task_run_id: string; task_plan_digest: string; created_at: string; state: string;
};

function metadata(value: unknown): ClaudeTaskUsage | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const item = value as ClaudeTaskUsage;
    const normalized = readClaudeTaskUsage({
      usage: item.tokens.status === "reported" ? item.tokens : item.tokens.status === "missing" ? undefined : null,
      total_cost_usd: item.estimated_cost.status === "reported" ? item.estimated_cost.usd
        : item.estimated_cost.status === "missing" ? undefined : null,
    });
    return canonicalize(normalized) === canonicalize(value) ? normalized : undefined;
  } catch { return undefined; }
}
function observation(value: unknown, returned: boolean): Observation {
  if (!returned) return { status: "unavailable", reason: "provider_result_unavailable" };
  if (value === undefined) return { status: "unavailable", reason: "metadata_missing" };
  const usage = metadata(value);
  return usage ? { status: "observed", usage } : { status: "unavailable", reason: "metadata_invalid" };
}
function binding(attempt: TaskUsageAttempt) {
  return { attempt_id: attempt.attempt_id, request_id: attempt.request_id, receipt_id: attempt.receipt_id,
    fence: attempt.lease_fence, run_id: attempt.task_run_id, execution_plan_digest: attempt.task_plan_digest };
}

/** Historical observation only: expiry/revocation cannot erase an already attempted call.
 * Identity must match the durable invocation; this event grants no execution authority. */
export function recordTaskProviderUsage(authority: AuthorityDb, command: ClaimedControlCommand,
  value: unknown, returned: boolean, now: Date): void {
  if (command.action !== "task.execute" || !Number.isFinite(now.getTime())) throw new JarvisError("TASK_USAGE_BINDING_INVALID");
  const observed = observation(value, returned);
  authority.db.transaction(() => {
    const attempt = authority.db.prepare(`SELECT * FROM control_effect_attempts WHERE request_id=? AND receipt_id=?
      AND lease_fence=? AND effect_type='task.execute' AND task_run_id IS NOT NULL`).get(command.request_id,
      command.receipt_id, command.fence) as TaskUsageAttempt | undefined;
    if (!attempt || !["invoking", "uncertain", "confirmed"].includes(attempt.state)
      || now.toISOString() < attempt.created_at) throw new JarvisError("TASK_USAGE_BINDING_INVALID");
    const payload = { schema_version: 1, binding: binding(attempt), observation: observed };
    const existing = authority.db.prepare("SELECT * FROM control_events WHERE event_id=?").get(taskUsageEventId(attempt.attempt_id));
    if (existing) {
      const stored = readTaskProviderUsage(authority, attempt, now);
      if (!stored || canonicalize(stored) !== canonicalize(observed)) throw new JarvisError("TASK_USAGE_REPLAY_CONFLICT");
      return;
    }
    new ControlPlane(authority).emit({ event_id: taskUsageEventId(attempt.attempt_id), event_type: TYPE,
      source: SOURCE, subject: attempt.attempt_id, correlation_id: command.request_id, causation_id: command.receipt_id,
      payload, created_at: now.toISOString() });
  }).immediate();
}

export function readTaskProviderUsage(authority: AuthorityDb, attempt: TaskUsageAttempt, now: Date): Observation | undefined {
  const row = authority.db.prepare("SELECT * FROM control_events WHERE event_id=?").get(taskUsageEventId(attempt.attempt_id)) as
    Record<string, any> | undefined;
  if (!row) return undefined;
  try {
    if (row.schema_version !== 1 || row.event_type !== TYPE || row.source !== SOURCE || row.subject !== attempt.attempt_id
      || row.correlation_id !== attempt.request_id || row.causation_id !== attempt.receipt_id
      || !candidateInstant(row.created_at) || row.created_at < attempt.created_at || row.created_at > now.toISOString()
      || typeof row.payload_json !== "string" || Buffer.byteLength(row.payload_json) > 4096
      || controlValueDigest(row.payload_json) !== row.payload_digest) throw new Error("invalid usage event");
    const payload = JSON.parse(row.payload_json);
    const observed = payload.observation;
    const normalized: Observation | undefined = observed?.status === "observed" && metadata(observed.usage)
      ? { status: "observed", usage: metadata(observed.usage)! }
      : observed?.status === "unavailable" && ["provider_result_unavailable", "metadata_missing", "metadata_invalid"].includes(observed.reason)
        ? { status: "unavailable", reason: observed.reason } : undefined;
    if (!normalized || canonicalize({ schema_version: 1, binding: binding(attempt), observation: normalized }) !== row.payload_json) {
      throw new Error("invalid usage payload");
    }
    return normalized;
  } catch { throw new JarvisError("TASK_USAGE_EVIDENCE_INVALID"); }
}
