import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { PersonalOsError } from "./personal-os-errors.js";
import type { RetentionAdapter } from "./personal-os-retention.js";

/** Explicit host adapter. No service registration or production deletion is implicit. */
export function createRemoteAuditRetentionAdapter(limit = 100): RetentionAdapter {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new PersonalOsError("E_RETENTION_POLICY");
  return (db, context) => {
    if (!db.inTransaction || context.policy.data_class !== "audit") throw new PersonalOsError("E_RETENTION_POLICY");
    const job = db.prepare(`SELECT lease_fence FROM retention_jobs WHERE job_id=? AND data_class='audit'
      AND job_key GLOB 'remote-auth:*' AND state='claimed' AND lease_owner IS NOT NULL
      AND policy_cutoff=? AND updated_at<=? AND not_before<=? AND lease_expires_at>? AND expires_at>?`)
      .get(context.job_id, context.policy.cutoff, context.now, context.now, context.now, context.now) as
      { lease_fence: number } | undefined;
    if (!job || !Number.isFinite(Date.parse(context.policy.cutoff)) || !Number.isFinite(Date.parse(context.now))
      || Date.parse(context.policy.cutoff) > Date.parse(context.now) - 365 * 86400000) {
      throw new PersonalOsError("E_RETENTION_POLICY");
    }
    const rows = db.prepare(`SELECT event_id,event_digest,event_type,outcome,reason_code,created_at
      FROM personal_operation_audit_events WHERE event_type LIKE 'remote.%' AND created_at<?
      ORDER BY created_at,event_id LIMIT ?`).all(context.policy.cutoff, limit) as Array<{
      event_id: string; event_digest: string; event_type: string; outcome: string | null; reason_code: string | null; created_at: string;
    }>;
    if (rows.length === 0) return { scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 };
    const digest = `sha256:${createHash("sha256").update("orca-jarvis/remote-audit-retirement/v1\0")
      .update(canonicalize({ job_id: context.job_id, fence: job.lease_fence, policy_digest: context.policy_digest, rows })).digest("hex")}`;
    const authorization = `remote-audit:${digest.slice(7)}`;
    db.prepare(`INSERT INTO remote_auth_retention_authorizations_v2
      (authorization_id,job_id,fence,cutoff,state,authorization_digest,created_at)
      VALUES(?,?,?,?,'applying',?,?)`).run(authorization, context.job_id, job.lease_fence, context.policy.cutoff, digest, context.now);
    for (const row of rows) {
      db.prepare(`INSERT INTO remote_audit_retired_events
        (event_id,event_digest,event_type,outcome,reason_code,created_at,authorization_id) VALUES(?,?,?,?,?,?,?)`)
        .run(row.event_id, row.event_digest, row.event_type, row.outcome, row.reason_code, row.created_at, authorization);
      if (db.prepare("DELETE FROM personal_operation_audit_events WHERE event_id=? AND event_digest=?")
        .run(row.event_id, row.event_digest).changes !== 1) throw new PersonalOsError("E_RETENTION_ADAPTER");
    }
    db.prepare("UPDATE remote_auth_retention_authorizations_v2 SET state='completed',completed_at=? WHERE authorization_id=?")
      .run(context.now, authorization);
    return { scanned: rows.length, eligible: rows.length, deleted: rows.length, retained: 0, error_count: 0 };
  };
}
