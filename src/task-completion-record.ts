import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { candidateHash, candidateInstant } from "./task-candidate-artifact-codec.js";
import { TaskPublicationJournal } from "./task-publication-journal.js";

export interface TaskCompletion {
  readonly schema_version: 1; readonly state: "completed"; readonly completion_id: string;
  readonly request_id: string; readonly fence: number; readonly command_digest: string; readonly run_id: string;
  readonly publication_id: string; readonly publication_digest: string; readonly verification_id: string;
  readonly artifact_id: string; readonly candidate_digest: string; readonly commit: string; readonly tree: string; readonly ref: string;
  readonly graph_digest: string; readonly from_node: string; readonly prior_attempts: number; readonly node_attempt: number;
  readonly observed_at: string; readonly completed_at: string;
}
export const taskCompletionInvalid = (): never => { throw new JarvisError("TASK_COMPLETION_INVALID"); };

/** Historical completion, not a new authority grant or a claim that the Git ref has never moved. */
export function readTaskCompletion(authority: AuthorityDb, requestId: string): TaskCompletion | null {
  return authority.db.transaction(() => {
    try {
      const row = authority.db.prepare(`SELECT c.*,r.command_digest,r.lease_fence,r.state AS command_state,
        a.state AS attempt_state,a.receipt_json,a.receipt_digest,a.task_run_id,
        w.state AS workflow_state,w.current_node,w.attempts,w.completed_at AS workflow_completed,d.spec_digest
        FROM task_completions c JOIN control_command_requests r ON r.request_id=c.request_id
        JOIN control_effect_attempts a ON a.attempt_id=c.attempt_id JOIN workflow_runs w ON w.run_id=c.run_id
        JOIN loop_definitions d ON d.loop_id=w.loop_id WHERE c.request_id=? AND length(CAST(c.payload_json AS BLOB))<=32768`)
        .get(requestId) as Record<string, any> | undefined;
      if (!row) {
        if (authority.db.prepare("SELECT 1 FROM task_completions WHERE request_id=?").get(requestId)) return taskCompletionInvalid();
        return null;
      }
      if (typeof row.payload_json !== "string" || Buffer.byteLength(row.payload_json) > 32768) return taskCompletionInvalid();
      const value = JSON.parse(row.payload_json) as TaskCompletion;
      const publication = new TaskPublicationJournal(authority).read(requestId);
      if (!publication || publication.state !== "published" || publication.attempt_id !== row.attempt_id
        || publication.publication_id !== row.publication_id || publication.binding.fence !== row.lease_fence
        || !publication.commit_oid || !publication.tree_oid || !publication.published_at) return taskCompletionInvalid();
      const completionId = `task-completion:${candidateHash(canonicalize({ publication: publication.publication_id,
        digest: publication.binding_digest })).slice(7)}`;
      const expected: TaskCompletion = { schema_version: 1, state: "completed", completion_id: completionId,
        request_id: requestId, fence: publication.binding.fence, command_digest: row.command_digest, run_id: row.run_id,
        publication_id: publication.publication_id, publication_digest: publication.binding_digest,
        verification_id: publication.verification_id, artifact_id: publication.binding.artifact_id,
        candidate_digest: publication.binding.candidate_digest, commit: publication.commit_oid, tree: publication.tree_oid,
        ref: publication.binding.ref, graph_digest: row.spec_digest, from_node: value.from_node,
        prior_attempts: value.prior_attempts, node_attempt: value.node_attempt, observed_at: value.observed_at, completed_at: row.created_at };
      if (row.completion_id !== completionId || row.payload_json !== canonicalize(expected) || row.payload_digest !== candidateHash(row.payload_json)
        || row.command_state !== "completed" || row.attempt_state !== "confirmed" || row.workflow_state !== "completed"
        || row.current_node !== "complete" || row.workflow_completed !== row.created_at || row.task_run_id !== row.run_id
        || row.receipt_json !== row.payload_json || row.receipt_digest !== row.payload_digest
        || !candidateInstant(value.observed_at) || !candidateInstant(value.completed_at)
        || value.observed_at < publication.published_at || value.completed_at < value.observed_at
        || typeof value.from_node !== "string" || !Number.isSafeInteger(value.prior_attempts) || value.prior_attempts < 0
        || row.attempts !== value.prior_attempts + 1 || !Number.isSafeInteger(value.node_attempt) || value.node_attempt < 1) {
        return taskCompletionInvalid();
      }
      const effect = authority.db.prepare(`SELECT 1 FROM control_command_effects WHERE request_id=?
        AND effect_type='task.execution.completed' AND payload_json=? AND payload_digest=? AND created_at=?`)
        .get(requestId, row.payload_json, row.payload_digest, row.created_at);
      const step = authority.db.prepare(`SELECT 1 FROM workflow_steps WHERE run_id=? AND node_id=? AND attempt=?
        AND outcome='task_verified' AND output_json=? AND output_digest=? AND evidence_digest=?`)
        .get(row.run_id, value.from_node, value.node_attempt, row.payload_json, row.payload_digest, row.payload_digest);
      const transition = authority.db.prepare(`SELECT 1 FROM workflow_transitions WHERE run_id=? AND from_node=?
        AND to_node='complete' AND outcome='task_verified' AND evidence_digest=?`).get(row.run_id, value.from_node, row.payload_digest);
      if (!effect || !step || !transition) return taskCompletionInvalid();
      return expected;
    } catch { return taskCompletionInvalid(); }
  }).deferred();
}
