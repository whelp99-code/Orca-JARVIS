import { randomUUID } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { TaskCandidateArtifacts } from "./task-candidate-artifacts.js";
import { TaskCandidateCertifications } from "./task-candidate-certifications.js";
import { candidateHash, candidateInstant } from "./task-candidate-artifact-codec.js";
import { remainingTaskExecutionBudget } from "./task-execution-clock.js";

type Row = { attempt_id: string; publication_id: string; verification_id: string; binding_json: string;
  binding_digest: string; state: string; tree_oid: string | null; commit_oid: string | null; created_at: string; published_at: string | null };
const invalid = (): never => { throw new JarvisError("TASK_PUBLICATION_AUTHORITY_INVALID"); };

export class TaskPublicationJournal {
  constructor(private readonly authority: AuthorityDb) {}

  /** Historical read only; an expired/uncertain publication is not permission to repeat Git effects. */
  read(requestId: string) {
    const row = this.authority.db.prepare(`SELECT * FROM task_git_publications WHERE json_extract(binding_json,'$.request_id')=?
      AND length(CAST(binding_json AS BLOB))<=16384`).get(requestId) as Row | undefined;
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as ReturnType<TaskPublicationJournal["context"]>["binding"];
    const artifact = new TaskCandidateArtifacts(this.authority).read(requestId);
    const certification = this.authority.db.prepare(`SELECT proof_digest,proof_json FROM task_candidate_certifications
      WHERE verification_id=? AND attempt_id=? AND state='recorded'
      AND length(CAST(proof_json AS BLOB))<=524288`).get(row.verification_id, row.attempt_id) as
      { proof_digest: string; proof_json: string } | undefined;
    const attempt = this.authority.db.prepare("SELECT receipt_id,lease_fence FROM control_effect_attempts WHERE attempt_id=? AND request_id=?")
      .get(row.attempt_id, requestId) as { receipt_id: string; lease_fence: number } | undefined;
    if (!artifact || artifact.attempt_id !== row.attempt_id || artifact.plan.schema_version !== 2 || !certification || !attempt) return invalid();
    if (typeof certification.proof_json !== "string" || candidateHash(certification.proof_json) !== certification.proof_digest) return invalid();
    const expected = { receipt_id: attempt.receipt_id, fence: attempt.lease_fence,
      attempt_id: row.attempt_id, request_id: requestId, verification_id: row.verification_id,
      artifact_id: artifact.artifact_id, candidate_digest: artifact.candidate_digest, payload_digest: artifact.payload_digest,
      execution_plan_digest: artifact.repository.execution_plan_digest, proof_digest: certification.proof_digest,
      root: artifact.plan.repository.root, baseline_commit: artifact.plan.repository.baseline_commit,
      ref: artifact.plan.publication.ref, repository_identity: artifact.plan.publication.repository_identity };
    const oid = new RegExp(`^[a-f0-9]{${artifact.plan.repository.baseline_commit.length}}$`);
    if (row.binding_json !== canonicalize(binding) || row.binding_digest !== candidateHash(row.binding_json)
      || canonicalize(expected) !== row.binding_json || !candidateInstant(row.created_at)
      || !["building", "prepared", "published", "uncertain"].includes(row.state)
      || (row.state === "published") !== (row.published_at !== null)
      || (row.commit_oid === null) !== (row.tree_oid === null)
      || (["prepared", "published"].includes(row.state) && row.commit_oid === null)
      || (row.published_at !== null && (!candidateInstant(row.published_at) || row.published_at < row.created_at))
      || (row.commit_oid !== null && (!oid.test(row.commit_oid) || !row.tree_oid || !oid.test(row.tree_oid)))) return invalid();
    return { ...row, binding };
  }

  private context(command: ClaimedControlCommand, verificationId: string, clock: () => Date) {
    const plan = assertTaskExecutionAuthority(this.authority, command, clock());
    if (plan.schema_version !== 2 || plan.mode !== "verified_git_commit") return invalid();
    const proof = new TaskCandidateCertifications(this.authority).requireProof(command, verificationId, clock);
    const artifact = new TaskCandidateArtifacts(this.authority).read(command.request_id);
    if (!artifact || artifact.artifact_id !== proof.request.artifact_id || artifact.verification?.state !== "checks_passed"
      || proof.measurement.state !== "checks_passed") return invalid();
    const binding = { request_id: command.request_id, receipt_id: command.receipt_id, fence: command.fence,
      attempt_id: artifact.attempt_id, verification_id: verificationId, artifact_id: artifact.artifact_id,
      proof_digest: candidateHash(canonicalize(proof)), candidate_digest: artifact.candidate_digest,
      payload_digest: artifact.payload_digest, execution_plan_digest: proof.request.execution_plan_digest,
      root: plan.repository.root, baseline_commit: plan.repository.baseline_commit, ref: plan.publication.ref,
      repository_identity: plan.publication.repository_identity };
    const remaining = Math.min(remainingTaskExecutionBudget(proof.request), Date.parse(command.lease_expires_at) - clock().getTime());
    if (remaining < 1) return invalid();
    assertTaskExecutionAuthority(this.authority, command, clock());
    return { plan, proof, artifact, binding, remaining_ms: remaining };
  }

  begin(command: ClaimedControlCommand, verificationId: string, clock: () => Date) {
    return this.authority.db.transaction(() => {
      const context = this.context(command, verificationId, clock); const publicationId = `task-publication:${randomUUID()}`;
      if (this.authority.db.prepare("SELECT 1 FROM task_git_publications WHERE attempt_id=?").get(context.artifact.attempt_id)) {
        throw new JarvisError("TASK_PUBLICATION_ALREADY_BOUND");
      }
      const json = canonicalize(context.binding); const createdAt = clock().toISOString();
      this.authority.db.prepare(`INSERT INTO task_git_publications
        (attempt_id,publication_id,verification_id,binding_json,binding_digest,state,created_at) VALUES(?,?,?,?,?,'building',?)`)
        .run(context.artifact.attempt_id, publicationId, verificationId, json, candidateHash(json), createdAt);
      return this.current(command, publicationId, ["building"], clock);
    }).immediate();
  }

  current(command: ClaimedControlCommand, publicationId: string, states: readonly string[], clock: () => Date) {
    return this.authority.db.transaction(() => {
      const row = this.authority.db.prepare(`SELECT * FROM task_git_publications WHERE publication_id=?
        AND length(CAST(binding_json AS BLOB))<=16384`).get(publicationId) as Row | undefined;
      if (!row || !states.includes(row.state)) return invalid();
      const context = this.context(command, row.verification_id, clock);
      if (row.attempt_id !== context.artifact.attempt_id || row.binding_json !== canonicalize(context.binding)
        || row.binding_digest !== candidateHash(row.binding_json)
        || this.authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?)")
          .get(row.publication_id, row.binding_digest, context.binding.proof_digest)) return invalid();
      return { ...context, row };
    }).immediate();
  }

  prepared(command: ClaimedControlCommand, publicationId: string, commit: { tree: string; commit: string }, clock: () => Date) {
    return this.authority.db.transaction(() => {
      const current = this.current(command, publicationId, ["building"], clock);
      const oid = new RegExp(`^[a-f0-9]{${current.plan.repository.baseline_commit.length}}$`);
      if (!oid.test(commit.tree) || !oid.test(commit.commit)) return invalid();
      this.authority.db.prepare("UPDATE task_git_publications SET state='prepared',tree_oid=?,commit_oid=? WHERE publication_id=? AND state='building'")
        .run(commit.tree, commit.commit, publicationId);
      return this.current(command, publicationId, ["prepared"], clock);
    }).immediate();
  }

  published(command: ClaimedControlCommand, publicationId: string, commit: string, clock: () => Date) {
    return this.authority.db.transaction(() => {
      const current = this.current(command, publicationId, ["prepared"], clock);
      if (current.row.commit_oid !== commit) return invalid();
      this.authority.db.prepare("UPDATE task_git_publications SET state='published',published_at=? WHERE publication_id=? AND state='prepared'")
        .run(clock().toISOString(), publicationId);
      return this.current(command, publicationId, ["published"], clock);
    }).immediate();
  }

  uncertain(command: ClaimedControlCommand, publicationId: string): void {
    if (command.action !== "task.execute") return invalid();
    const changed = this.authority.db.prepare(`UPDATE task_git_publications SET state='uncertain',error_code='TASK_PUBLICATION_UNCERTAIN'
      WHERE publication_id=? AND state IN ('building','prepared') AND json_extract(binding_json,'$.request_id')=?
        AND json_extract(binding_json,'$.receipt_id')=? AND json_extract(binding_json,'$.fence')=?`)
      .run(publicationId, command.request_id, command.receipt_id, command.fence);
    if (changed.changes !== 1) return invalid();
  }
}
