import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

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
    const effect = context(command);
    this.authority.db.prepare(
      `INSERT INTO control_effect_attempts(
         attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(`attempt:${effect.idempotency_key.slice(7)}`, command.request_id, command.receipt_id,
      command.fence, effectType, effect.idempotency_key, "prepared", at.toISOString(), at.toISOString());
    return effect;
  }

  update(requestId: string, state: "invoking" | "confirmed" | "uncertain", at: Date,
    receipt?: unknown, errorCode?: string): void {
    const receiptJson = receipt === undefined ? null : canonicalize(receipt);
    const receiptDigest = receiptJson === null ? null : `sha256:${createHash("sha256")
      .update(receiptJson).digest("hex")}`;
    const changed = this.authority.db.prepare(
      `UPDATE control_effect_attempts
       SET state=?,receipt_json=?,receipt_digest=?,error_code=?,updated_at=? WHERE request_id=?`,
    ).run(state, receiptJson, receiptDigest, errorCode ?? null, at.toISOString(), requestId);
    if (changed.changes !== 1) throw new JarvisError("EXTERNAL_EFFECT_ATTEMPT_MISSING");
  }
}
