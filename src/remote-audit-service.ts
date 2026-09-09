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
    return { status: row.state === "completed" ? "completed" : ["failed", "uncertain"].includes(row.state) ? "error" : "pending",
      job_id: jobId, scope: "one_utc_daily_batch", cutoff, limit: this.limit,
      state: row.state, result_digest: row.result_digest, code: row.failure_code };
  }
}
