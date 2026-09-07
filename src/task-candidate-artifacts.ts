import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest } from "./task-execution-plan.js";
import type { TaskSandboxFile } from "./task-sandbox.js";
import type { TaskRepositoryCheck } from "./task-execution-workspace.js";
import { artifactInvalid, candidateHash, candidateInstant, CANDIDATE_PAYLOAD_LIMIT, CANDIDATE_MEASUREMENT_LIMIT,
  decodeTaskCandidate, encodeTaskCandidate, validateCandidateMeasurement } from "./task-candidate-artifact-codec.js";

export class TaskCandidateArtifacts {
  constructor(private readonly authority: AuthorityDb) {}

  private binding(command: ClaimedControlCommand, clock: () => Date) {
    const now = clock();
    const plan = assertTaskExecutionAuthority(this.authority, command, now);
    const attempt = this.authority.db.prepare(`SELECT attempt_id FROM control_effect_attempts
      WHERE request_id=? AND receipt_id=? AND lease_fence=? AND task_run_id=? AND task_plan_digest=?
        AND effect_type='task.execute' AND state='invoking'`).get(command.request_id, command.receipt_id,
      command.fence, plan.run_id, taskExecutionPlanDigest(plan)) as { attempt_id: string } | undefined;
    if (!attempt) throw new JarvisError("TASK_EXECUTION_INVOCATION_CONFLICT");
    return { plan, attempt, now };
  }

  /** A committed candidate survives verifier failure; reservation and workflow states are unchanged. */
  save(command: ClaimedControlCommand, input: { files: readonly TaskSandboxFile[]; repository: TaskRepositoryCheck;
    provider_output_bytes: number }, clock: () => Date = () => new Date(), beforeWrite?: () => void) {
    return this.authority.db.transaction(() => {
      const { plan, attempt } = this.binding(command, clock);
      const encoded = encodeTaskCandidate(attempt.attempt_id, plan, input.files, input.repository, input.provider_output_bytes);
      const existing = this.readInside(command.request_id);
      if (existing) {
        if (existing.payload_digest !== encoded.payload_digest) throw new JarvisError("TASK_CANDIDATE_ARTIFACT_CONFLICT");
        return existing;
      }
      const { now } = this.binding(command, clock);
      beforeWrite?.();
      this.authority.db.prepare(`INSERT INTO task_candidate_artifacts
        (attempt_id,candidate_digest,payload,payload_digest,created_at) VALUES(?,?,?,?,?)`)
        .run(attempt.attempt_id, encoded.candidate.candidate_digest, encoded.payload, encoded.payload_digest, now.toISOString());
      const saved = this.readInside(command.request_id)!;
      this.binding(command, clock); beforeWrite?.();
      return saved;
    }).immediate();
  }

  recordVerification(command: ClaimedControlCommand, value: unknown,
    clock: () => Date = () => new Date(), beforeWrite?: () => void) {
    return this.authority.db.transaction(() => {
      this.binding(command, clock);
      const stored = this.readInside(command.request_id);
      if (!stored) throw new JarvisError("TASK_CANDIDATE_ARTIFACT_MISSING");
      const encoded = encodeTaskCandidate(stored.attempt_id, stored.plan, stored.files, stored.repository, stored.provider_output_bytes);
      const measurement = validateCandidateMeasurement(encoded, value);
      const json = canonicalize(measurement);
      if (Buffer.byteLength(json) > CANDIDATE_MEASUREMENT_LIMIT) return artifactInvalid();
      if (stored.verification !== null) {
        if (canonicalize(stored.verification) !== json) throw new JarvisError("TASK_CANDIDATE_ARTIFACT_CONFLICT");
        return stored;
      }
      const { now } = this.binding(command, clock);
      const at = now.toISOString();
      const digest = candidateHash(canonicalize({ verified_at: at, measurement }));
      beforeWrite?.();
      const changed = this.authority.db.prepare(`UPDATE task_candidate_artifacts
        SET verification_json=?,verification_digest=?,verified_at=? WHERE attempt_id=? AND verification_json IS NULL`)
        .run(json, digest, at, stored.attempt_id);
      if (changed.changes !== 1) throw new JarvisError("TASK_CANDIDATE_ARTIFACT_CONFLICT");
      const saved = this.readInside(command.request_id)!;
      this.binding(command, clock); beforeWrite?.();
      return saved;
    }).immediate();
  }

  /** Read-only historical recovery, including after lease expiry. Returned bytes never authorize execution or publication. */
  read(requestId: string) {
    return this.authority.db.transaction(() => this.readInside(requestId)).deferred();
  }

  private readInside(requestId: string) {
    try {
      const row = this.authority.db.prepare(`SELECT c.*,a.task_plan_digest,a.state AS attempt_state,r.args_json
        FROM task_candidate_artifacts c JOIN control_effect_attempts a ON a.attempt_id=c.attempt_id
        JOIN control_command_requests r ON r.request_id=a.request_id
        WHERE a.request_id=? AND typeof(c.payload)='blob' AND length(c.payload)<=?
          AND length(CAST(r.args_json AS BLOB))<=4194304
          AND (c.verification_json IS NULL OR length(CAST(c.verification_json AS BLOB))<=?)`)
        .get(requestId, CANDIDATE_PAYLOAD_LIMIT, CANDIDATE_MEASUREMENT_LIMIT) as Record<string, any> | undefined;
      if (!row) {
        if (this.authority.db.prepare(`SELECT 1 FROM task_candidate_artifacts c
          JOIN control_effect_attempts a ON a.attempt_id=c.attempt_id WHERE a.request_id=?`).get(requestId)) return artifactInvalid();
        return null;
      }
      const plan = parseTaskExecutionPlan(JSON.parse(row.args_json).plan);
      const decoded = decodeTaskCandidate(row.attempt_id, plan, row.payload);
      if (!candidateInstant(row.created_at) || decoded.payload_digest !== row.payload_digest
        || decoded.candidate.execution_plan_digest !== row.task_plan_digest
        || decoded.candidate.candidate_digest !== row.candidate_digest
        || !["invoking", "uncertain", "confirmed"].includes(row.attempt_state)) return artifactInvalid();
      const verification = row.verification_json === null ? null : validateCandidateMeasurement(decoded, JSON.parse(row.verification_json));
      if (verification === null ? row.verification_digest !== null || row.verified_at !== null
        : !candidateInstant(row.verified_at) || row.verified_at < row.created_at
          || canonicalize(verification) !== row.verification_json
          || candidateHash(canonicalize({ verified_at: row.verified_at, measurement: verification })) !== row.verification_digest) {
        return artifactInvalid();
      }
      return { artifact_id: `task-candidate:${candidateHash(canonicalize({ attempt_id: row.attempt_id,
        payload_digest: row.payload_digest })).slice(7)}`, attempt_id: String(row.attempt_id), request_id: requestId,
      payload_digest: decoded.payload_digest, candidate_digest: decoded.candidate.candidate_digest,
      created_at: String(row.created_at), verified_at: row.verified_at as string | null,
      plan, files: decoded.candidate.frozen, repository: decoded.repository,
      provider_output_bytes: decoded.provider_output_bytes, verification };
    } catch { return artifactInvalid(); }
  }
}
