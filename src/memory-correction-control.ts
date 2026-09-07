import { canonicalize } from "./canonical.js";
import { controlValueDigest as hash } from "./control-plane-contract.js";
import { ControlPlane } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { correctionCommandAuthority, invalidCorrectionControl as invalid,
  type CorrectionControlRow } from "./memory-correction-control-binding.js";
import { correctionTerminalProof } from "./memory-correction-control-proof.js";

export function reconcileCorrectionControl(authority: AuthorityDb, correctionId: string, now: Date): boolean {
  return authority.db.transaction(() => {
    const record = authority.db.prepare("SELECT * FROM memory_correction_requests WHERE correction_id=?")
      .get(correctionId) as CorrectionControlRow | undefined;
    if (!record) return invalid();
    const row = authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
      .get(record.control_request_id) as Record<string, unknown> | undefined;
    if (!row) return invalid();
    if (!["claimed", "uncertain"].includes(String(row.state))) return false;
    if (authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
      .get(record.control_request_id, record.control_receipt_id)
      || authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?)")
        .get(record.control_request_id, record.control_command_digest, record.control_receipt_id)) return false;
    let payload: ReturnType<typeof correctionTerminalProof>; let fence: number;
    try {
      ({ fence } = correctionCommandAuthority(authority, record, row));
      payload = correctionTerminalProof(authority, record, now);
    } catch { return invalid(); }
    const requestId = record.control_request_id; const at = now.toISOString();
    const effectId = `effect:${hash({ requestId, fence, outcome: "completed", payload }).slice(7)}`;
    const encoded = canonicalize(payload);
    authority.db.prepare("INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)")
      .run(effectId, requestId, "memory.correction.settled", encoded, hash(encoded), at);
    const changed = authority.db.prepare(`UPDATE control_command_requests SET state='completed',completed_at=?,
      failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state=? AND lease_fence=?`)
      .run(at, requestId, row.state, fence);
    if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
    authority.db.prepare("UPDATE memory_effect_preparations SET state='consumed',updated_at=? WHERE lane_id=? AND state='approved'")
      .run(at, record.lane_id);
    new ControlPlane(authority).emit({ event_id: `evt:${requestId}:completed:${fence}`,
      event_type: "control.command.completed", source: "jarvis-memory-correction", subject: requestId,
      correlation_id: requestId, causation_id: payload.terminal_event_id,
      payload: { effect_id: effectId, failure_code: null }, created_at: at });
    return true;
  }).immediate();
}

export function reconcileCorrectionControls(authority: AuthorityDb, now: Date, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new JarvisError("MEMORY_LIFECYCLE_LIMIT_INVALID");
  try { return authority.db.transaction(() => {
  const cursor = authority.db.prepare("SELECT * FROM memory_correction_control_cursor WHERE singleton_id=1")
    .get() as { last_updated_at: string; last_correction_id: string } | undefined;
  const rows = authority.db.prepare(`SELECT c.correction_id,c.updated_at FROM memory_correction_requests c
    JOIN control_command_requests r ON r.request_id=c.control_request_id WHERE c.state='settled'
    AND (r.state='uncertain' OR (r.state='claimed' AND r.lease_expires_at<=?))
    ORDER BY CASE WHEN (c.updated_at,c.correction_id)>(?,?) THEN 0 ELSE 1 END,c.updated_at,c.correction_id LIMIT ?`)
    .all(now.toISOString(), cursor?.last_updated_at ?? "", cursor?.last_correction_id ?? "", limit) as
      { correction_id: string; updated_at: string }[];
  let correction_controls_reconciled = 0; let correction_control_error: string | undefined;
  for (const row of rows) {
    try { if (reconcileCorrectionControl(authority, row.correction_id, now)) correction_controls_reconciled += 1; }
    catch (error) { correction_control_error = error instanceof JarvisError
      && error.code === "MEMORY_CORRECTION_CONTROL_EVIDENCE_INVALID" ? error.code : "MEMORY_CORRECTION_CONTROL_RECONCILE_FAILED"; }
  }
  const last = rows.at(-1);
  if (last) authority.db.prepare(`INSERT INTO memory_correction_control_cursor VALUES(1,?,?)
    ON CONFLICT(singleton_id) DO UPDATE SET last_updated_at=excluded.last_updated_at,last_correction_id=excluded.last_correction_id`)
    .run(last.updated_at, last.correction_id);
  return { correction_controls_reconciled, ...(correction_control_error === undefined ? {} : { correction_control_error }) };
  }).immediate(); } catch {
    return { correction_controls_reconciled: 0, correction_control_error: "MEMORY_CORRECTION_CONTROL_RECONCILE_FAILED" };
  }
}
