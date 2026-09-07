import { createPublicKey, type KeyObject } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { TaskCandidateCertifications } from "./task-candidate-certifications.js";
import { verifyTaskCandidate } from "./task-candidate-verification.js";
import { spawnTaskSandbox } from "./task-sandbox.js";
import { signTaskCertification } from "./task-certification-proof.js";

/** Verifier entry only: re-read durable candidate, claim one invocation, run real sandbox checks, then sign. */
export async function verifyStoredTaskCandidate(authority: AuthorityDb, command: ClaimedControlCommand,
  verificationId: string, privateKey: KeyObject, clock: () => Date = () => new Date()) {
  const certifications = new TaskCandidateCertifications(authority);
  const initial = certifications.begin(command, verificationId, clock);
  const invocationId = initial.invocation_id;
  const current = () => certifications.current(command, verificationId, invocationId, clock);
  try {
    const publicBytes = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519"
      || !publicBytes.equals(createPublicKey(initial.publicKey).export({ type: "spki", format: "der" }))) {
      throw new JarvisError("TASK_CERTIFICATION_KEY_INVALID");
    }
    let outputBytes = initial.request.max_output_bytes;
    const measurement = await verifyTaskCandidate(initial.artifact.plan, initial.artifact.files, async input => {
      const context = current();
      const result = await spawnTaskSandbox({ ...input, timeout_ms: Math.min(input.timeout_ms, context.remaining_ms),
        max_output_bytes: Math.min(input.max_output_bytes, outputBytes), before_spawn: () => current().remaining_ms });
      current();
      outputBytes -= result.stdout_bytes + result.stderr_bytes;
      if (outputBytes < 0) throw new JarvisError("TASK_SANDBOX_OUTPUT_LIMIT");
      return result;
    });
    current();
    const proof = signTaskCertification({ schema_version: 1, request: initial.request, invocation_id: invocationId,
      measurement, principal_id: "independent-verifier", algorithm: "Ed25519", issued_at: clock().toISOString() }, privateKey);
    current();
    return proof;
  } catch (error) {
    certifications.uncertain(command, verificationId, invocationId);
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("TASK_CERTIFICATION_FAILED");
  }
}
