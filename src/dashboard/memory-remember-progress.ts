import { ControlPlane } from "../control-plane.js";
import type { AuthorityDb } from "../db.js";

/** Bounded metadata projection; command visibility still follows the existing suppression policy. */
export function memoryRememberProgress(authority: AuthorityDb, now: Date, limit: number) {
  const rows = authority.db.prepare(
    `SELECT r.request_id,r.failure_code,o.state AS outbox_state,o.failure_code AS outbox_failure
     FROM control_command_requests r LEFT JOIN memory_outbox o ON o.action_request_id=r.request_id
     WHERE r.action='memory.outbox.dispatch' AND json_extract(r.args_json,'$.schema_version')=2
     ORDER BY r.requested_at DESC,r.request_id LIMIT ?`,
  ).all(limit) as Array<{ request_id: string; failure_code: string | null;
    outbox_state: string | null; outbox_failure: string | null }>;
  const control = new ControlPlane(authority);
  return { schema_version: 1 as const, resource: "memory-remember-progress" as const,
    generated_at: now.toISOString(), items: rows.flatMap(row => {
      const command = control.get(row.request_id);
      return command === undefined ? [] : [{ request_id: command.request_id,
        state: command.state, outbox_state: row.outbox_state, failure_code: row.failure_code ?? row.outbox_failure,
        stored: command.state === "completed" && row.outbox_state === "settled" }];
    }), has_more: rows.length === limit };
}
