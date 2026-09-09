import type { ApprovedExecutionResult } from "./approved-executor-types.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { ControlEffectAttempts } from "./control-effect-attempts.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { readTaskCompletion } from "./task-completion-record.js";

export function completedTaskExecution(authority: AuthorityDb, requestId: string): ApprovedExecutionResult | undefined {
  const completion = readTaskCompletion(authority, requestId);
  return completion ? { request_id: requestId, action: "task.execute", state: "completed", result: completion } : undefined;
}

/** Preserve committed success, cancellation and authority loss. Never replay an external effect on an error. */
export function settleApprovedTaskError(authority: AuthorityDb, command: ClaimedControlCommand, code: string,
  checksFailed: boolean, clock: () => Date): ApprovedExecutionResult {
  try { return authority.db.transaction(() => {
    const now = clock();
    const success = completedTaskExecution(authority, command.request_id); if (success) return success;
    const control = new ControlPlane(authority);
    const bound = authority.db.prepare(`SELECT 1 FROM control_command_requests r
      JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
      WHERE r.request_id=? AND r.action='task.execute' AND r.command_digest=? AND r.lease_fence=? AND x.receipt_id=?`)
      .get(command.request_id, command.command_digest, command.fence, command.receipt_id);
    if (!bound) throw new JarvisError("TASK_EXECUTION_AUTHORITY_INVALID");
    const attempt = authority.db.prepare(`SELECT state FROM control_effect_attempts
      WHERE request_id=? AND receipt_id=? AND lease_fence=? AND task_run_id IS NOT NULL`)
      .get(command.request_id, command.receipt_id, command.fence) as { state: string } | undefined;
    if (attempt && ["prepared", "invoking"].includes(attempt.state)) new ControlEffectAttempts(authority).markTaskUncertain(command, now);
    // Settlement reads only internal state after verifying the exact redeemed authority above.
    // Public visibility may disappear while the provider is running.
    const readState = () => authority.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?")
      .get(command.request_id) as { state: string } | undefined;
    let stored = readState();
    if (stored?.state === "claimed") {
      const state = checksFailed || !attempt ? "failed" : "uncertain";
      try { control.settle(command.request_id, command.fence, { state,
        effect_type: state === "failed" ? "task.execution.failed" : "task.execution.uncertain", payload: { code }, failure_code: code }, now); }
      catch (error) {
        // ControlPlane may have durably projected expiry/revocation to uncertain before throwing.
        stored = readState();
        if (!(error instanceof JarvisError) || stored?.state !== "uncertain") throw error;
      }
    }
    stored = readState();
    if (!stored || !["failed", "uncertain"].includes(stored.state)) throw new JarvisError("TASK_EXECUTION_SETTLEMENT_FAILED");
    const failure = authority.db.prepare("SELECT failure_code FROM control_command_requests WHERE request_id=?")
      .get(command.request_id) as { failure_code: string | null };
    const failureCode = failure.failure_code ?? code;
    return { request_id: command.request_id, action: "task.execute", state: stored.state as "failed" | "uncertain",
      result: { code: failureCode }, failure_code: failureCode };
  }).immediate(); }
  catch (error) { if (error instanceof JarvisError) throw error; throw new JarvisError("TASK_EXECUTION_SETTLEMENT_FAILED"); }
}
