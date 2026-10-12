import { ControlPlane } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { MemoryOutboxCycleResult } from "./memory-outbox-types.js";
import { requireLimit } from "./memory-outbox-values.js";
import { memoryOutboxFailure, tagMemoryOutboxFailure, type MemoryOutboxFailure } from "./memory-outbox-diagnostic.js";

/** Bounded durable recovery also covers a crash between outbox and control commits. */
export function reconcileMemoryOutboxCommands(authority: AuthorityDb, now: Date, limit: number): {
  commands_reconciled: number; control_error?: MemoryOutboxCycleResult["control_error"]; failure?: MemoryOutboxFailure;
} {
  const bound = requireLimit(limit);
  try { return authority.db.transaction(() => {
  const cursor = authority.db.prepare("SELECT last_updated_at,last_outbox_id FROM memory_outbox_control_cursor WHERE singleton_id=1")
    .get() as { last_updated_at: string; last_outbox_id: string } | undefined;
  const rows = authority.db.prepare(
    `SELECT o.outbox_id,o.updated_at FROM memory_outbox o JOIN control_command_requests r ON r.request_id=o.action_request_id
     WHERE o.request_profile='legacy' AND o.state IN ('settled','conflict','failed','expired')
       AND (r.state='uncertain' OR (r.state='claimed' AND r.lease_expires_at<=?))
       AND NOT EXISTS (SELECT 1 FROM control_command_revocations v
         WHERE v.request_id=r.request_id OR v.receipt_id=o.action_receipt_id)
       AND NOT EXISTS (SELECT 1 FROM authority_revocations v
         WHERE v.reference IN (r.request_id,r.command_digest,o.action_receipt_id))
     ORDER BY CASE WHEN (o.updated_at,o.outbox_id)>(?,?) THEN 0 ELSE 1 END,o.updated_at,o.outbox_id LIMIT ?`,
  ).all(now.toISOString(), cursor?.last_updated_at ?? "", cursor?.last_outbox_id ?? "", bound) as {
    outbox_id: string; updated_at: string }[];
  const control = new ControlPlane(authority); let count = 0; let error: MemoryOutboxCycleResult["control_error"];
  let diagnostic: MemoryOutboxFailure | undefined;
  for (const row of rows) {
    try { if (control.reconcileMemoryOutbox(row.outbox_id, now)) count += 1; }
    catch (failure) {
      diagnostic ??= memoryOutboxFailure(tagMemoryOutboxFailure("control_reconciliation", failure));
      error = failure instanceof JarvisError && failure.code === "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID"
        ? failure.code : "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED";
    }
  }
  const last = rows.at(-1);
  if (last !== undefined) authority.db.prepare(
    `INSERT INTO memory_outbox_control_cursor(singleton_id,last_updated_at,last_outbox_id) VALUES(1,?,?)
     ON CONFLICT(singleton_id) DO UPDATE SET last_updated_at=excluded.last_updated_at,last_outbox_id=excluded.last_outbox_id`,
  ).run(last.updated_at, last.outbox_id);
  return { commands_reconciled: count,
    ...(diagnostic === undefined ? {} : { failure: diagnostic }),
    ...(error === undefined ? {} : { control_error: error }) };
  }).immediate(); }
  catch (error) { return { commands_reconciled: 0, control_error: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
    failure: memoryOutboxFailure(tagMemoryOutboxFailure("control_reconciliation", error)) }; }
}
