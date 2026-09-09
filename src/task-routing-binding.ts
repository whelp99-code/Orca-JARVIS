import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { classifyWorkRouting } from "./work-routing.js";

/** A per-task proposal, signed as part of TaskSpec. It is not installed policy. */
export interface TaskRoutingBinding {
  readonly schema_version: 1;
  readonly policy: unknown;
  readonly decision_digest: string;
  readonly executor_id: string;
}

export function parseTaskRoutingBinding(value: unknown, objective: string): TaskRoutingBinding {
  const invalid = (): never => { throw new JarvisError("TASK_ROUTING_BINDING_INVALID"); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "decision_digest,executor_id,policy,schema_version") return invalid();
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1 || typeof row.executor_id !== "string") return invalid();
  let decision: ReturnType<typeof classifyWorkRouting>;
  try { decision = classifyWorkRouting({ schema_version: 1, objective }, row.policy); }
  catch { return invalid(); }
  if (decision.status !== "classified") throw new JarvisError("TASK_ROUTING_REVIEW_REQUIRED");
  if (row.decision_digest !== decision.decision_digest
    || !decision.matches[0]!.proposed_executor_ids.includes(row.executor_id)) return invalid();
  return JSON.parse(canonicalize(value)) as TaskRoutingBinding;
}
