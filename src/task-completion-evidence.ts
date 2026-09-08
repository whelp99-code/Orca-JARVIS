import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { readTaskCompletion, taskCompletionInvalid } from "./task-completion-record.js";
import { TaskPublicationJournal } from "./task-publication-journal.js";
import { TaskCandidateArtifacts } from "./task-candidate-artifacts.js";
import { candidateHash, candidateInstant, encodeTaskCandidate } from "./task-candidate-artifact-codec.js";
import { taskCertificationVerifierKey } from "./task-certification-context.js";
import { verifyTaskCertification, type TaskCertificationRequest } from "./task-certification-proof.js";

/** Internal historical evidence, not an authorization or a privacy-filtered public projection. */
export function readTaskCompletionEvidence(authority: AuthorityDb, requestId: string, observedAt: Date) {
  return authority.db.transaction(() => {
    try {
      if (!Number.isFinite(observedAt.getTime())) return taskCompletionInvalid();
      const completion = readTaskCompletion(authority, requestId);
      if (completion === null) return null;
      if (completion.completed_at > observedAt.toISOString()) return taskCompletionInvalid();
      const publication = new TaskPublicationJournal(authority).read(requestId);
      const artifact = new TaskCandidateArtifacts(authority).read(requestId);
      const row = authority.db.prepare(`SELECT request_json,request_digest,proof_json,proof_digest,invocation_id,started_at,created_at
        FROM task_candidate_certifications WHERE verification_id=? AND state='recorded'
        AND length(CAST(request_json AS BLOB))<=16384 AND length(CAST(proof_json AS BLOB))<=524288`)
        .get(completion.verification_id) as Record<string, string> | undefined;
      if (!publication || !artifact || !row || typeof row.request_json !== "string" || typeof row.proof_json !== "string"
        || candidateHash(row.request_json) !== row.request_digest || candidateHash(row.proof_json) !== row.proof_digest
        || row.proof_digest !== publication.binding.proof_digest) return taskCompletionInvalid();
      const request = JSON.parse(row.request_json) as TaskCertificationRequest;
      if (canonicalize(request) !== row.request_json || request.schema_version !== 1
        || request.verification_id !== completion.verification_id || request.attempt_id !== artifact.attempt_id
        || request.request_id !== requestId || request.receipt_id !== publication.binding.receipt_id
        || request.fence !== completion.fence || request.run_id !== completion.run_id
        || request.task_id !== artifact.plan.task_id || request.task_spec_digest !== artifact.plan.task_spec_digest
        || request.execution_plan_digest !== artifact.repository.execution_plan_digest
        || request.artifact_id !== artifact.artifact_id || request.payload_digest !== artifact.payload_digest
        || request.candidate_digest !== completion.candidate_digest || request.requested_at !== row.created_at
        || !candidateInstant(row.created_at) || !candidateInstant(row.started_at)
        || row.created_at < artifact.created_at || row.started_at < row.created_at
        || row.started_at > completion.completed_at || typeof row.invocation_id !== "string") return taskCompletionInvalid();
      const references = [requestId, request.receipt_id, completion.command_digest, request.key_id,
        row.request_digest!, row.invocation_id, completion.verification_id, artifact.artifact_id,
        publication.publication_id, publication.binding_digest, row.proof_digest!];
      const decision = authority.db.prepare("SELECT key_id FROM control_command_receipts WHERE receipt_id=?")
        .get(request.receipt_id) as { key_id: string } | undefined;
      if (!decision) return taskCompletionInvalid();
      references.push(decision.key_id);
      if (authority.db.prepare(`SELECT 1 FROM authority_revocations WHERE reference IN (${references.map(() => "?").join(",")})`)
        .get(...references) || authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
        .get(requestId, request.receipt_id)) return taskCompletionInvalid();
      const encoded = encodeTaskCandidate(artifact.attempt_id, artifact.plan, artifact.files, artifact.repository, artifact.provider_output_bytes);
      const proof = verifyTaskCertification(JSON.parse(row.proof_json), request, row.invocation_id, encoded,
        taskCertificationVerifierKey(authority, request.key_id), row.started_at, new Date(completion.completed_at));
      if (proof.measurement.state !== "checks_passed" || proof.issued_at > publication.published_at!
        || canonicalize(proof.measurement) !== canonicalize(artifact.verification)) return taskCompletionInvalid();
      return { completion, proof, proof_digest: row.proof_digest! };
    } catch { return taskCompletionInvalid(); }
  }).deferred();
}
