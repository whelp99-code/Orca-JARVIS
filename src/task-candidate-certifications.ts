import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { candidateHash, candidateInstant } from "./task-candidate-artifact-codec.js";
import { certificationInvalid, taskCertificationContext } from "./task-certification-context.js";
import { verifyTaskCertification, type TaskCertificationRequest } from "./task-certification-proof.js";

type CertificationRow = { attempt_id: string; verification_id: string; request_json: string; request_digest: string;
  state: string; invocation_id: string | null; started_at: string | null; proof_json: string | null;
  proof_digest: string | null; created_at: string };
export class TaskCandidateCertifications {
  constructor(private readonly authority: AuthorityDb) {}

  pending(command: ClaimedControlCommand, verificationId: string, clock: () => Date = () => new Date()) {
    return this.authority.db.transaction(() => this.context(command, verificationId, clock, ["reserved"])).immediate();
  }

  prepare(command: ClaimedControlCommand, keyId: string, clock: () => Date = () => new Date()): TaskCertificationRequest {
    return this.authority.db.transaction(() => {
      const now = clock();
      const verificationId = `task-verification:${randomUUID()}`;
      const { request } = taskCertificationContext(this.authority, command, keyId, verificationId, now.toISOString(), clock);
      if (this.authority.db.prepare("SELECT 1 FROM task_candidate_certifications WHERE attempt_id=?").get(request.attempt_id)) {
        throw new JarvisError("TASK_CERTIFICATION_ALREADY_BOUND");
      }
      const json = canonicalize(request);
      if (Buffer.byteLength(json) > 16384) return certificationInvalid();
      this.authority.db.prepare(`INSERT INTO task_candidate_certifications
        (attempt_id,verification_id,request_json,request_digest,state,created_at) VALUES(?,?,?,?,'reserved',?)`)
        .run(request.attempt_id, verificationId, json, candidateHash(json), now.toISOString());
      this.context(command, verificationId, clock, ["reserved"]);
      return request;
    }).immediate();
  }

  begin(command: ClaimedControlCommand, verificationId: string, clock: () => Date = () => new Date()) {
    return this.authority.db.transaction(() => {
      const initial = this.context(command, verificationId, clock, ["reserved"]);
      const invocationId = randomUUID();
      const now = clock();
      const changed = this.authority.db.prepare(`UPDATE task_candidate_certifications SET state='running',invocation_id=?,started_at=?
        WHERE verification_id=? AND state='reserved' AND invocation_id IS NULL`).run(invocationId, now.toISOString(), verificationId);
      if (changed.changes !== 1) throw new JarvisError("TASK_CERTIFICATION_INVOCATION_CONFLICT");
      const current = this.context(command, verificationId, clock, ["running"], invocationId);
      if (initial.row.request_digest !== current.row.request_digest) return certificationInvalid();
      return { ...current, invocation_id: invocationId };
    }).immediate();
  }

  current(command: ClaimedControlCommand, verificationId: string, invocationId: string, clock: () => Date = () => new Date()) {
    return this.authority.db.transaction(() => this.context(command, verificationId, clock, ["running"], invocationId)).immediate();
  }

  record(command: ClaimedControlCommand, verificationId: string, invocationId: string, value: unknown,
    clock: () => Date = () => new Date()) {
    return this.authority.db.transaction(() => {
      const current = this.context(command, verificationId, clock, ["running", "recorded"], invocationId);
      const proof = verifyTaskCertification(value, current.request, invocationId, current.encoded,
        current.publicKey, current.row.started_at!, clock());
      const json = canonicalize(proof);
      if (current.row.state === "recorded") {
        if (current.row.proof_json !== json || current.row.proof_digest !== candidateHash(json)) {
          throw new JarvisError("TASK_CERTIFICATION_PROOF_CONFLICT");
        }
        return proof;
      }
      const changed = this.authority.db.prepare(`UPDATE task_candidate_certifications SET state='recorded',proof_json=?,proof_digest=?
        WHERE verification_id=? AND state='running' AND invocation_id=?`).run(json, candidateHash(json), verificationId, invocationId);
      if (changed.changes !== 1) throw new JarvisError("TASK_CERTIFICATION_INVOCATION_CONFLICT");
      this.context(command, verificationId, clock, ["recorded"], invocationId);
      return proof;
    }).immediate();
  }

  requireProof(command: ClaimedControlCommand, verificationId: string, clock: () => Date = () => new Date()) {
    return this.authority.db.transaction(() => {
      const current = this.context(command, verificationId, clock, ["recorded"]);
      if (!current.row.proof_json || candidateHash(current.row.proof_json) !== current.row.proof_digest) return certificationInvalid();
      return verifyTaskCertification(JSON.parse(current.row.proof_json), current.request, current.row.invocation_id!, current.encoded,
        current.publicKey, current.row.started_at!, clock());
    }).immediate();
  }

  uncertain(command: ClaimedControlCommand, verificationId: string, invocationId: string): void {
    if (command.action !== "task.execute") return certificationInvalid();
    const changed = this.authority.db.prepare(`UPDATE task_candidate_certifications SET state='uncertain',error_code='TASK_CERTIFICATION_UNCERTAIN'
      WHERE verification_id=? AND invocation_id=? AND state='running'
        AND json_extract(request_json,'$.request_id')=? AND json_extract(request_json,'$.receipt_id')=?
        AND json_extract(request_json,'$.fence')=?`).run(verificationId, invocationId, command.request_id, command.receipt_id, command.fence);
    if (changed.changes !== 1) throw new JarvisError("TASK_CERTIFICATION_INVOCATION_CONFLICT");
  }

  private context(command: ClaimedControlCommand, verificationId: string, clock: () => Date, states: readonly string[], invocationId?: string) {
    const now = clock();
    const row = this.authority.db.prepare(`SELECT * FROM task_candidate_certifications WHERE verification_id=?
      AND length(CAST(request_json AS BLOB))<=16384 AND (proof_json IS NULL OR length(CAST(proof_json AS BLOB))<=524288)`)
      .get(verificationId) as CertificationRow | undefined;
    if (!row || !states.includes(row.state) || (invocationId !== undefined && invocationId !== row.invocation_id)) {
      throw new JarvisError("TASK_CERTIFICATION_INVOCATION_CONFLICT");
    }
    const stored = JSON.parse(row.request_json) as TaskCertificationRequest;
    const context = taskCertificationContext(this.authority, command, stored.key_id, verificationId, row.created_at, clock);
    if (canonicalize(context.request) !== row.request_json || candidateHash(row.request_json) !== row.request_digest
      || row.attempt_id !== context.artifact.attempt_id || (row.state !== "reserved"
        && (!row.invocation_id || !candidateInstant(row.started_at) || row.started_at < row.created_at
          || Date.parse(row.started_at) > now.getTime()))
      || this.authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?)")
        .get(verificationId, row.invocation_id, row.request_digest, context.artifact.artifact_id)) return certificationInvalid();
    return { ...context, row };
  }
}
