import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { TaskPublicationJournal } from "./task-publication-journal.js";
import { TaskPublicationGit } from "./task-publication-git.js";
import { candidateHash } from "./task-candidate-artifact-codec.js";
import { remainingTaskExecutionBudget } from "./task-execution-clock.js";
import { taskCompletionWorkflow, recordTaskWorkflowCompletion } from "./task-completion-workflow.js";
import { readTaskCompletion, taskCompletionInvalid, type TaskCompletion } from "./task-completion-record.js";
import { executeTaskPlan } from "./task-certified-execution.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";

function replay(authority: AuthorityDb, command: ClaimedControlCommand) {
  const result = readTaskCompletion(authority, command.request_id);
  if (result) {
    const stored = new ControlPlane(authority).get(command.request_id);
    if (command.action !== "task.execute" || result.command_digest !== command.command_digest || result.fence !== command.fence
      || !stored || stored.action_level !== command.action_level || stored.reversible !== command.reversible
      || canonicalize(stored.args) !== canonicalize(command.args) || canonicalize(stored.target) !== canonicalize(command.target)
      || new TaskPublicationJournal(authority).read(command.request_id)?.binding.receipt_id !== command.receipt_id) return taskCompletionInvalid();
  }
  return result;
}

/** Settle one current published attempt. No provider, verifier or ref mutation is retried here. */
export async function settleTaskExecution(input: { authority: AuthorityDb; command: ClaimedControlCommand;
  publication_id: string; clock?: () => Date }): Promise<TaskCompletion> {
  const { authority } = input; const command = structuredClone(input.command); const clock = input.clock ?? (() => new Date());
  const prior = replay(authority, command);
  if (prior) {
    if (prior.publication_id !== input.publication_id) return taskCompletionInvalid();
    return prior;
  }
  const journal = new TaskPublicationJournal(authority);
  const initial = journal.current(command, input.publication_id, ["published"], clock);
  taskCompletionWorkflow(authority, initial.plan.run_id, clock());
  const git = await TaskPublicationGit.open(initial.plan.repository.root,
    () => journal.current(command, input.publication_id, ["published"], clock).remaining_ms,
    initial.row.created_at, true, initial.binding.repository_identity);
  try {
    const observed = await git.readRef(initial.binding.ref); const observedAt = clock().toISOString();
    if (observed?.oid !== initial.row.commit_oid || observed?.symbolic !== "") throw new JarvisError("TASK_COMPLETION_REF_CONFLICT");
    return authority.db.transaction(() => {
      const concurrent = replay(authority, command);
      if (concurrent) {
        if (concurrent.publication_id !== input.publication_id) return taskCompletionInvalid();
        return concurrent;
      }
      const current = journal.current(command, input.publication_id, ["published"], clock);
      const workflow = taskCompletionWorkflow(authority, current.plan.run_id, clock());
      const now = clock(); const at = now.toISOString();
      if (!current.row.commit_oid || !current.row.tree_oid || observedAt < current.row.published_at! || at < observedAt) return taskCompletionInvalid();
      const completion: TaskCompletion = { schema_version: 1, state: "completed",
        completion_id: `task-completion:${candidateHash(canonicalize({ publication: input.publication_id, digest: current.row.binding_digest })).slice(7)}`,
        request_id: command.request_id, fence: command.fence, command_digest: command.command_digest, run_id: current.plan.run_id,
        publication_id: input.publication_id, publication_digest: current.row.binding_digest, verification_id: current.row.verification_id,
        artifact_id: current.artifact.artifact_id, candidate_digest: current.artifact.candidate_digest,
        commit: current.row.commit_oid, tree: current.row.tree_oid, ref: current.binding.ref,
        graph_digest: workflow.graph_digest, from_node: workflow.run.current_node, prior_attempts: workflow.run.attempts,
        node_attempt: workflow.node_attempt, observed_at: observedAt, completed_at: at };
      const json = canonicalize(completion); const digest = candidateHash(json);
      authority.db.prepare(`INSERT INTO task_completions
        (run_id,request_id,attempt_id,publication_id,completion_id,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(completion.run_id, command.request_id, current.artifact.attempt_id, input.publication_id, completion.completion_id, json, digest, at);
      const changed = authority.db.prepare(`UPDATE control_effect_attempts
        SET state='confirmed',receipt_json=?,receipt_digest=?,updated_at=? WHERE attempt_id=? AND state='invoking'`)
        .run(json, digest, at, current.artifact.attempt_id);
      if (changed.changes !== 1) return taskCompletionInvalid();
      new ControlPlane(authority).settle(command.request_id, command.fence,
        { state: "completed", effect_type: "task.execution.completed", payload: completion }, now);
      recordTaskWorkflowCompletion(authority, completion, digest);
      const result = readTaskCompletion(authority, command.request_id);
      // IMMEDIATE excludes concurrent authority writes. Recheck revocations after our own triggers/events as well.
      const references = [command.request_id, command.receipt_id, command.command_digest, current.proof.request.key_id,
        current.proof.invocation_id, current.row.verification_id, current.artifact.artifact_id, current.row.publication_id,
        current.row.binding_digest, current.binding.proof_digest, candidateHash(canonicalize(current.proof.request))];
      const decision = authority.db.prepare("SELECT key_id FROM control_command_receipts WHERE receipt_id=?")
        .get(command.receipt_id) as { key_id: string };
      references.push(decision.key_id);
      if (authority.db.prepare(`SELECT 1 FROM authority_revocations WHERE reference IN (${references.map(() => "?").join(",")})`)
        .get(...references) || authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
        .get(command.request_id, command.receipt_id)) return taskCompletionInvalid();
      const final = clock(); remainingTaskExecutionBudget(current.proof.request);
      if (!result || !Number.isFinite(final.getTime()) || final < now || final.getTime() >= Date.parse(command.lease_expires_at)
        || final.getTime() >= Date.parse(workflow.deadline)) return taskCompletionInvalid();
      return result;
    }).immediate();
  } finally { await git.close(); }
}

export async function executeTaskWorkflow(input: Parameters<typeof executeTaskPlan>[0]) {
  const command = structuredClone(input.command); const previous = replay(input.authority, command);
  if (previous) return previous;
  const plan = parseTaskExecutionPlan(command.args.plan);
  assertTaskExecutionAuthority(input.authority, command, (input.clock ?? (() => new Date()))());
  if (plan.schema_version !== 2) throw new JarvisError("TASK_COMPLETION_MODE_UNSUPPORTED");
  taskCompletionWorkflow(input.authority, plan.run_id, (input.clock ?? (() => new Date()))());
  const result = await executeTaskPlan({ ...input, command });
  if (!result.published) return result;
  return await settleTaskExecution({ authority: input.authority, command, publication_id: result.publication_id, clock: input.clock });
}
