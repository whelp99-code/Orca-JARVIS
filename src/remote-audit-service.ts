import { RetentionRuntime } from "./personal-os-retention.js";
import { createRemoteAuditRetentionAdapter } from "./remote-audit-retention.js";
import { PersonalOsError } from "./personal-os-errors.js";
import type { Database } from "better-sqlite3";

/** One explicitly configured, bounded remote-audit batch per UTC date. */
export class RemoteAuditService {
  private readonly runtime: RetentionRuntime;
  constructor(private readonly db: Database, private readonly limit: number, private readonly clock: () => Date) {
    this.runtime = new RetentionRuntime(db, "remote-audit-service", { audit: createRemoteAuditRetentionAdapter(limit) }, clock);
  }
  cycle() {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new PersonalOsError("E_CLOCK_INVALID");
    const date = now.toISOString().slice(0, 10), start = `${date}T00:00:00.000Z`;
    const cutoff = new Date(Date.parse(start) - 365 * 86400000).toISOString();
    const expires = new Date(Date.parse(start) + 86400000).toISOString();
    const jobId = `remote-auth:daily:v1:${date}`, key = `${jobId}:limit:${this.limit}`;
    const row = this.db.transaction(() => {
      let job = this.read(jobId);
      if (!job) {
        this.runtime.createJob({ jobId, jobKey: key, idempotencyKey: key, dataClass: "audit", createdAt: now.toISOString(),
          notBefore: start, expiresAt: expires, cutoff });
        job = this.read(jobId)!;
      }
      if (job.job_key !== key || job.idempotency_key !== key || job.data_class !== "audit"
        || job.policy_cutoff !== cutoff || job.not_before !== start || job.expires_at !== expires) {
        throw new PersonalOsError("E_RETENTION_POLICY");
      }
      // Expired claims are not evidence of a completed effect. Never replay them.
      this.db.prepare(`UPDATE retention_jobs SET
        state=CASE WHEN state='pending' THEN 'failed' ELSE 'uncertain' END,
        failure_code='E_RETENTION_EXPIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE job_id IN (SELECT job_id FROM retention_jobs
          WHERE data_class='audit' AND job_id GLOB 'remote-auth:daily:v1:????-??-??'
            AND state IN ('pending','claimed') AND expires_at<=? AND updated_at<=?
          ORDER BY expires_at,job_id LIMIT 100)`).run(now.toISOString(), now.toISOString(), now.toISOString());
      return job;
    }).immediate();
    if (["completed", "failed", "uncertain"].includes(row.state)) return this.result(jobId, cutoff, row);
    const lease = new Date(Math.min(now.getTime() + 60000, Date.parse(expires))).toISOString();
    const claimed = this.runtime.claimDue({ jobId, now: now.toISOString(), leaseExpiresAt: lease });
    if (claimed.length === 0) return this.result(jobId, cutoff, this.read(jobId)!);
    try { this.runtime.executeClaimed({ jobId, now: now.toISOString(), cutoff }); }
    catch (error) {
      if (!(error instanceof PersonalOsError)) throw error;
      return { ...this.result(jobId, cutoff, this.read(jobId)!), status: "error", code: error.code };
    }
    return this.result(jobId, cutoff, this.read(jobId)!);
  }
  private read(jobId: string) {
    return this.db.prepare(`SELECT job_key,idempotency_key,data_class,policy_cutoff,not_before,expires_at,
      state,result_digest,failure_code FROM retention_jobs WHERE job_id=?`).get(jobId) as {
      job_key: string; idempotency_key: string; data_class: string; policy_cutoff: string; not_before: string; expires_at: string;
      state: string; result_digest: string | null; failure_code: string | null;
    } | undefined;
  }
  private result(jobId: string, cutoff: string, row: NonNullable<ReturnType<RemoteAuditService["read"]>>) {
    const expiry_history = this.db.prepare(`SELECT
      COALESCE(SUM(state='failed'),0) AS never_started,
      COALESCE(SUM(state='uncertain'),0) AS outcome_unknown
      FROM retention_jobs WHERE data_class='audit'
        AND job_id GLOB 'remote-auth:daily:v1:????-??-??'
        AND state IN ('failed','uncertain') AND failure_code='E_RETENTION_EXPIRED'`).get() as {
          never_started: number; outcome_unknown: number;
        };
    return { status: row.state === "completed" ? "completed" : ["failed", "uncertain"].includes(row.state) ? "error" : "pending",
      job_id: jobId, scope: "one_utc_daily_batch", cutoff, limit: this.limit,
      state: row.state, result_digest: row.result_digest, code: row.failure_code,
      expiry_history: { scope: "recorded_daily_job_expirations", ...expiry_history } };
  }
}
