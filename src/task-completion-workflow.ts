import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { DEFAULT_AGENTOPS_LOOP, LoopGraph } from "./loopgraph.js";
import { ControlPlane } from "./control-plane.js";
import { candidateHash } from "./task-candidate-artifact-codec.js";
import type { TaskCompletion } from "./task-completion-record.js";

/** One evidence projection for the exact built-in graph, consuming the existing step/node budget. */
export function taskCompletionWorkflow(authority: AuthorityDb, runId: string, now: Date) {
  const run = new LoopGraph(authority).get(runId);
  const definition = authority.db.prepare("SELECT spec_json,spec_digest,state FROM loop_definitions WHERE loop_id=?")
    .get(run.loop_id) as { spec_json: string; spec_digest: string; state: string } | undefined;
  const expected = canonicalize(DEFAULT_AGENTOPS_LOOP);
  if (run.loop_id !== DEFAULT_AGENTOPS_LOOP.loop_id || definition?.state !== "active" || definition.spec_json !== expected
    || definition.spec_digest !== candidateHash(expected)) throw new JarvisError("TASK_COMPLETION_WORKFLOW_UNSUPPORTED");
  const budget = run.budget as { deadline: string; max_steps: number; max_attempts_per_node: number };
  const node = DEFAULT_AGENTOPS_LOOP.nodes.find(node => node.id === run.current_node);
  const nodeAttempt = Number((authority.db.prepare("SELECT count(*) AS n FROM workflow_steps WHERE run_id=? AND node_id=?")
    .get(runId, run.current_node) as { n: number }).n) + 1;
  if (!node || !["running", "waiting_approval"].includes(run.state) || !Number.isFinite(now.getTime())
    || !Number.isFinite(Date.parse(budget.deadline)) || Date.parse(budget.deadline) <= now.getTime()
    || !Number.isSafeInteger(budget.max_steps) || run.attempts >= budget.max_steps
    || !Number.isSafeInteger(budget.max_attempts_per_node) || nodeAttempt > budget.max_attempts_per_node) {
    throw new JarvisError("TASK_COMPLETION_WORKFLOW_NOT_READY");
  }
  return { run, node_attempt: nodeAttempt, graph_digest: definition.spec_digest, deadline: budget.deadline };
}

export function recordTaskWorkflowCompletion(authority: AuthorityDb, completion: TaskCompletion, payloadDigest: string): void {
  const json = canonicalize(completion); const at = completion.completed_at;
  authority.db.prepare(`INSERT INTO workflow_steps
    (step_id,run_id,node_id,attempt,outcome,output_json,output_digest,evidence_digest,created_at) VALUES(?,?,?,?,'task_verified',?,?,?,?)`)
    .run(`step:${completion.completion_id}`, completion.run_id, completion.from_node, completion.node_attempt, json, payloadDigest, payloadDigest, at);
  authority.db.prepare(`INSERT INTO workflow_transitions
    (transition_id,run_id,from_node,to_node,outcome,evidence_digest,created_at) VALUES(?,?,?,'complete','task_verified',?,?)`)
    .run(`transition:${completion.completion_id}`, completion.run_id, completion.from_node, payloadDigest, at);
  const changed = authority.db.prepare(`UPDATE workflow_runs
    SET state='completed',current_node='complete',attempts=attempts+1,updated_at=?,completed_at=?
    WHERE run_id=? AND current_node=? AND attempts=? AND state IN ('running','waiting_approval')`)
    .run(at, at, completion.run_id, completion.from_node, completion.prior_attempts);
  if (changed.changes !== 1) throw new JarvisError("TASK_COMPLETION_WORKFLOW_CONFLICT");
  const run = new LoopGraph(authority).get(completion.run_id);
  new ControlPlane(authority).emit({ event_id: `evt:workflow:${completion.run_id}:task-completed`, event_type: "workflow.task_completed",
    source: "jarvis-task-executor", subject: completion.run_id, correlation_id: run.correlation_id,
    causation_id: `evt:${completion.request_id}:completed:${completion.fence}`, payload: completion, created_at: at });
}
