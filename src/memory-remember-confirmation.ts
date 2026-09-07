import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";

/** Complete the claimed command for the owner decision already committed by ControlPlane.decide. */
export function completeMemoryRememberDecision(authority: AuthorityDb, command: ClaimedControlCommand, now: Date) {
  if (command.action !== "memory.confirm" || command.action_level !== 3 || command.args.schema_version !== 1
    || command.args.operation !== "remember" || !["confirm", "reject"].includes(String(command.args.decision))) {
    throw new JarvisError("MEMORY_CONFIRMATION_INVALID");
  }
  return authority.db.transaction(() => {
    const row = authority.db.prepare(
      `SELECT c.state FROM memory_candidate_owner_decisions d
       JOIN memory_candidates c ON c.candidate_id=d.candidate_id
       JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
       JOIN memory_candidate_decision_attempts a ON a.attempt_id=d.attempt_id
       WHERE d.control_request_id=? AND d.control_receipt_id=? AND d.command_digest=?
         AND d.candidate_id=? AND d.decision=? AND c.operation='remember'
         AND m.candidate_digest=? AND m.classification_digest=? AND c.content_digest=?
         AND a.state='applied'`,
    ).get(command.request_id, command.receipt_id, command.command_digest, command.target.candidate_id,
      command.args.decision, command.target.candidate_digest, command.target.classification_digest,
      command.args.content_digest) as { state: string } | undefined;
    const state = command.args.decision === "confirm" ? "approved" : "rejected";
    if (row?.state !== state) throw new JarvisError("MEMORY_CONFIRMATION_INVALID");
    const result = { candidate_id: String(command.target.candidate_id), state };
    new ControlPlane(authority).settle(command.request_id, command.fence, { state: "completed",
      effect_type: "memory.candidate.decision", payload: result }, now);
    return result;
  }).immediate();
}
