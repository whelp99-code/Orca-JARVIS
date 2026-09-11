import { candidateTaskSourceClosed } from "./memory-candidate-task-source.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { ControlPlane } from "./control-plane.js";

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update("orca-jarvis/memory-correction-confirmation/v1\0")
    .update(canonicalize(value)).digest("hex")}`;
}

export function confirmMemoryCorrectionCandidate(
  authority: AuthorityDb,
  command: ClaimedControlCommand,
  now: Date,
): void {
  if (command.action !== "memory.confirm" || command.action_level !== 3
    || command.args.schema_version !== 1 || command.args.operation !== "correct"
    || typeof command.target.candidate_id !== "string"
    || typeof command.args.evidence_digest !== "string") {
    throw new JarvisError("MEMORY_CORRECTION_CONFIRMATION_INVALID");
  }
  const candidateId = command.target.candidate_id;
  return authority.db.transaction(() => {
    if (new MemoryProjectionAuthority(authority).isProjectionIdSuppressed(candidateId)
      // The correction lane approves the same candidates the remember lane does, and an owner who
      // hid the work hid it for both.
      || candidateTaskSourceClosed(authority, candidateId)) {
      throw new JarvisError("MEMORY_CANDIDATE_SUPPRESSED");
    }
    const candidate = authority.db.prepare(
      "SELECT operation FROM memory_candidates WHERE candidate_id=? AND state='awaiting_confirmation'",
    ).get(command.target.candidate_id) as { readonly operation: string } | undefined;
    if (candidate?.operation !== "correct") {
      throw new JarvisError("MEMORY_CORRECTION_CONFIRMATION_INVALID");
    }
    const receipt = authority.db.prepare(
      "SELECT payload_json,signature FROM control_command_receipts WHERE receipt_id=? AND request_id=?",
    ).get(command.receipt_id, command.request_id) as {
      readonly payload_json: string;
      readonly signature: string;
    } | undefined;
    if (receipt === undefined) throw new JarvisError("MEMORY_CORRECTION_CONFIRMATION_INVALID");
    const receiptDigest = digest(receipt);
    const changed = authority.db.prepare(
      `UPDATE memory_candidates SET state='approved',confirmation_principal_id='principal:owner',
       confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,
       confirmation_evidence_digest=?,updated_at=?
       WHERE candidate_id=? AND state='awaiting_confirmation'`,
    ).run(command.request_id, command.receipt_id, receiptDigest, command.args.evidence_digest,
      now.toISOString(), command.target.candidate_id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_CORRECTION_CONFIRMATION_INVALID");
    new ControlPlane(authority).settle(command.request_id, command.fence, {
      state: "completed",
      effect_type: "memory.candidate.confirmed",
      payload: {
        candidate_id: command.target.candidate_id,
        confirmation_receipt_digest: receiptDigest,
      },
    }, now);
  }).immediate();
}
