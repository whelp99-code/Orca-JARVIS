import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { taskExecutionPlanDigest } from "./task-execution-plan.js";

export type ExternalEffectContext = {
  readonly request_id: string;
  readonly fence: number;
  readonly effect_id: string;
  readonly idempotency_key: string;
};

function context(command: ClaimedControlCommand): ExternalEffectContext {
  const payload = canonicalize({
    request_id: command.request_id,
    receipt_id: command.receipt_id,
    fence: command.fence,
    action: command.action,
  });
  const idempotencyKey = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  return {
    request_id: command.request_id,
    fence: command.fence,
    effect_id: `external-effect:${idempotencyKey.slice(7)}`,
    idempotency_key: idempotencyKey,
  };
}

export class ControlEffectAttempts {
  constructor(private readonly authority: AuthorityDb) {}

  prepare(command: ClaimedControlCommand, effectType: string, at: Date): ExternalEffectContext {
    if (command.action === "task.execute" || effectType === "task.execute") {
      if (effectType !== "task.execute") throw new JarvisError("TASK_EXECUTION_EFFECT_INVALID");
      return this.prepareTask(command, () => at);
    }
    const effect = context(command);
    this.authority.db.prepare(
      `INSERT INTO control_effect_attempts(
         attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(`attempt:${effect.idempotency_key.slice(7)}`, command.request_id, command.receipt_id,
      command.fence, effectType, effect.idempotency_key, "prepared", at.toISOString(), at.toISOString());
    return effect;
  }

  /** A fresh request/receipt/fence cannot reserve a second invocation of the same approved plan. */
  prepareTask(command: ClaimedControlCommand, clock: () => Date = () => new Date()): ExternalEffectContext {
    return this.authority.db.transaction(() => {
      const now = clock();
      const plan = assertTaskExecutionAuthority(this.authority, command, now);
      const digest = taskExecutionPlanDigest(plan);
      if (this.authority.db.prepare(`SELECT 1 FROM control_effect_attempts WHERE task_run_id=? AND task_plan_digest=?`)
        .get(plan.run_id, digest)) throw new JarvisError("TASK_EXECUTION_ALREADY_BOUND");
      const effect = context(command);
      this.authority.db.prepare(`INSERT INTO control_effect_attempts(
        attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at,task_run_id,task_plan_digest
        ) VALUES(?,?,?,?,?,?,'prepared',?,?,?,?)`).run(`attempt:${effect.idempotency_key.slice(7)}`, command.request_id,
        command.receipt_id, command.fence, "task.execute", effect.idempotency_key, now.toISOString(), now.toISOString(), plan.run_id, digest);
      return effect;
    }).immediate();
  }

  beginTaskInvocation(command: ClaimedControlCommand, clock: () => Date = () => new Date()): ExternalEffectContext {
    return this.authority.db.transaction(() => {
      const now = clock();
      const plan = assertTaskExecutionAuthority(this.authority, command, now);
      const effect = context(command);
      const changed = this.authority.db.prepare(`UPDATE control_effect_attempts SET state='invoking',updated_at=?
        WHERE request_id=? AND receipt_id=? AND lease_fence=? AND idempotency_key=? AND task_run_id=?
          AND task_plan_digest=? AND state='prepared'`).run(now.toISOString(), command.request_id,
        command.receipt_id, command.fence, effect.idempotency_key, plan.run_id, taskExecutionPlanDigest(plan));
      if (changed.changes !== 1) throw new JarvisError("TASK_EXECUTION_INVOCATION_CONFLICT");
      return effect;
    }).immediate();
  }

  /** Logging an uncertain outcome must remain possible after authority expiry or cancellation. */
  markTaskUncertain(command: ClaimedControlCommand, at = new Date()): void {
    if (command.action !== "task.execute" || !Number.isFinite(at.getTime())) throw new JarvisError("TASK_EXECUTION_EFFECT_INVALID");
    const changed = this.authority.db.prepare(`UPDATE control_effect_attempts
      SET state='uncertain',error_code='TASK_EXECUTION_UNCERTAIN',updated_at=?
      WHERE request_id=? AND receipt_id=? AND lease_fence=? AND idempotency_key=?
        AND task_run_id IS NOT NULL AND state IN ('prepared','invoking')`)
      .run(at.toISOString(), command.request_id, command.receipt_id, command.fence, context(command).idempotency_key);
    if (changed.changes !== 1) throw new JarvisError("TASK_EXECUTION_INVOCATION_CONFLICT");
  }

  update(requestId: string, state: "invoking" | "confirmed" | "uncertain", at: Date,
    receipt?: unknown, errorCode?: string): void {
    const receiptJson = receipt === undefined ? null : canonicalize(receipt);
    const receiptDigest = receiptJson === null ? null : `sha256:${createHash("sha256")
      .update(receiptJson).digest("hex")}`;
    const changed = this.authority.db.prepare(
      `UPDATE control_effect_attempts
       SET state=?,receipt_json=?,receipt_digest=?,error_code=?,updated_at=? WHERE request_id=? AND task_run_id IS NULL`,
    ).run(state, receiptJson, receiptDigest, errorCode ?? null, at.toISOString(), requestId);
    if (changed.changes !== 1) throw new JarvisError("EXTERNAL_EFFECT_ATTEMPT_MISSING");
  }
}
