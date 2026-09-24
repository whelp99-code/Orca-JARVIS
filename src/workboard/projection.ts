import type Database from "better-sqlite3";
import { attentionQueue, evaluateAttention, type AttentionItem, type AttentionRow } from "./attention.js";

export type WorkboardProjection = { works: Array<AttentionRow & { attention: AttentionItem }>; attention: AttentionItem[] };

/** Read-only: collectors own all projection writes. No CLI calls, cache writes, or authority-table joins. */
export function readWorkboard(db: Database.Database, now: Date): WorkboardProjection {
  const rows = db.prepare(`SELECT w.*, s.warning, s.last_successful_observation,
    a.last_progress_received_at, a.attempt_execution, a.action_delivery,
    a.wait_kind, a.wait_reason, a.wait_started_at, a.deadline_at, a.impact, a.decision_valid
    FROM workboard_works w JOIN workboard_sources s ON s.source_key=w.source_key
    LEFT JOIN workboard_attention a ON a.work_id=w.work_id ORDER BY w.work_id`).all() as AttentionRow[];
  return { works: rows.map(row => ({ ...row, attention: evaluateAttention(row, now) })), attention: attentionQueue(rows, now) };
}
