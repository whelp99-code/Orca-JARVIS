import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

type Event = { event_id: string; event_digest: string; event_type: string; outcome: string | null;
  reason_code: string | null; created_at: string };
const columns = "event_id,event_digest,event_type,outcome,reason_code,created_at";
function digest(domain: string, value: unknown) {
  return `sha256:${createHash("sha256").update(`orca-jarvis/${domain}\0`).update(canonicalize(value)).digest("hex")}`;
}
function invalid(): never { throw new JarvisError("REMOTE_AUDIT_HISTORY_INVALID"); }

/** Minimal stored history. Never returns principal, assertion or request metadata. */
export function readRemoteAuditHistory(db: Database, eventId: string) {
  if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 4096 || !eventId.isWellFormed()) {
    throw new JarvisError("REMOTE_AUDIT_HISTORY_INPUT_INVALID");
  }
  return db.transaction(() => {
    const active = db.prepare(`SELECT ${columns} FROM personal_operation_audit_events
      WHERE event_id=? AND event_type LIKE 'remote.%'`).get(eventId) as Event | undefined;
    const retired = db.prepare(`SELECT ${columns},authorization_id FROM remote_audit_retired_events
      WHERE event_id=?`).get(eventId) as (Event & { authorization_id: string }) | undefined;
    if (active && retired) return invalid();
    if (active) return { state: "active" as const, event: active, evidence: "stored_event" as const };
    if (!retired) return { state: "not_found" as const };
    const authorization = db.prepare(`SELECT a.job_id,a.fence,a.cutoff,a.authorization_digest,a.state,
      j.state AS job_state,j.job_key,j.data_class,j.policy_cutoff,j.lease_fence,j.result_digest
      FROM remote_auth_retention_authorizations_v2 a JOIN retention_jobs j ON j.job_id=a.job_id
      WHERE a.authorization_id=?`).get(retired.authorization_id) as {
      job_id: string; fence: number; cutoff: string; authorization_digest: string; state: string;
      job_state: string; job_key: string; data_class: string; policy_cutoff: string; lease_fence: number; result_digest: string;
    } | undefined;
    if (!authorization || authorization.state !== "completed" || authorization.job_state !== "completed"
      || authorization.data_class !== "audit" || !authorization.job_key.startsWith("remote-auth:")
      || authorization.cutoff !== authorization.policy_cutoff || authorization.fence !== authorization.lease_fence) return invalid();
    const rows = db.prepare(`SELECT ${columns} FROM remote_audit_retired_events WHERE authorization_id=?
      ORDER BY created_at,event_id LIMIT 1001`).all(retired.authorization_id) as Event[];
    if (rows.length < 1 || rows.length > 1000) return invalid();
    const policy = { schema_version: 1, data_class: "audit", cutoff: authorization.cutoff };
    const policy_digest = digest("retention-policy/v2", policy);
    const expected = digest("remote-audit-retirement/v1", {
      job_id: authorization.job_id, fence: authorization.fence, policy_digest, rows,
    });
    const counts = { scanned: rows.length, eligible: rows.length, deleted: rows.length, retained: 0, error_count: 0 };
    const receipt = digest("retention-receipt/v1", { ...counts, cutoff: authorization.cutoff, policy_digest, fence: authorization.fence });
    if (authorization.authorization_digest !== expected || retired.authorization_id !== `remote-audit:${expected.slice(7)}`
      || authorization.result_digest !== receipt) return invalid();
    const event = rows.find(row => row.event_id === eventId);
    if (!event) return invalid();
    return { state: "retired" as const, event, evidence: "verified_retirement_bindings" as const };
  }).deferred();
}
