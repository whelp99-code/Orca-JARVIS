import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { PersonalOsError } from "./personal-os-errors.js";

export const RETENTION_DATA_CLASSES = ["observation", "context", "recommendation", "notification", "memory_candidate", "audit", "delete"] as const;

export type RetentionDataClass = (typeof RETENTION_DATA_CLASSES)[number];

export type RetentionCounts = {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly retained: number;
  readonly error_count: number;
};

export type RetentionPolicy = {
  readonly schema_version: 1;
  readonly data_class: RetentionDataClass;
  readonly cutoff: string;
};
export type RetentionAdapterContext = {
  readonly job_id: string;
  readonly now: string;
  readonly policy: RetentionPolicy;
  readonly policy_digest: string;
};
/** Adapters perform synchronous changes on this SQLite connection only. */
export type RetentionAdapter = (db: Database, context: RetentionAdapterContext) => RetentionCounts;
export type RetentionAdapterMap = Partial<Record<RetentionDataClass, RetentionAdapter>>;

export type RetentionReceipt = RetentionCounts & {
  readonly cutoff: string;
  readonly policy_digest: string;
  readonly fence: number;
  readonly result_digest: string;
};

export type RetentionJobInput = {
  readonly jobId: string;
  readonly jobKey: string;
  readonly idempotencyKey: string;
  readonly dataClass: RetentionDataClass;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly cutoff: string;
};

export class RetentionRuntime {
  private readonly owner: string;
  constructor(
    private readonly db: Database,
    owner: string,
    private readonly adapters: RetentionAdapterMap,
    private readonly clock: () => Date = () => new Date(),
  ) { this.owner = `${owner}:${process.pid}:${randomUUID()}`; }

  createJob(input: RetentionJobInput): void {
    if (!validTimestamp(input.cutoff) || !validTimestamp(input.createdAt) || input.cutoff > input.createdAt
      || !validTimestamp(input.notBefore) || !validTimestamp(input.expiresAt)
      || input.expiresAt <= input.notBefore || input.expiresAt <= input.createdAt) {
      throw new PersonalOsError("E_RETENTION_POLICY");
    }
    this.db
      .prepare(
        "INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at," +
          "created_at,updated_at,policy_cutoff) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.jobId,
        input.jobKey,
        input.idempotencyKey,
        input.dataClass,
        "pending",
        0,
        input.notBefore,
        input.expiresAt,
        input.createdAt,
        input.createdAt,
        input.cutoff,
      );
  }

  claimDue(input: { readonly now: string; readonly leaseExpiresAt: string; readonly jobId?: string }): readonly string[] {
    return this.db.transaction(() => {
      const now = this.now();
      if (input.jobId !== undefined && (typeof input.jobId !== "string" || input.jobId.length === 0)) {
        throw new PersonalOsError("E_RETENTION_CLAIM");
      }
      if (!validTimestamp(input.now) || !validTimestamp(input.leaseExpiresAt) || input.now > now
        || input.leaseExpiresAt <= now || Date.parse(input.leaseExpiresAt) - Date.parse(now) > 900000) {
        throw new PersonalOsError("E_CLOCK_INVALID");
      }
      const rows = this.db.prepare(
        "SELECT job_id,state,lease_fence,expires_at FROM retention_jobs WHERE not_before<=? AND expires_at>? AND updated_at<=? " +
        "AND (state='pending' OR (state='claimed' AND lease_expires_at<=? AND lease_owner<>?)) " +
        "AND (? IS NULL OR job_id=?) " +
        "ORDER BY not_before,job_id LIMIT 100",
      ).all(now, now, now, now, this.owner, input.jobId ?? null, input.jobId ?? null) as Array<{
        job_id: string; state: string; lease_fence: number; expires_at: string;
      }>;
      const claimed: string[] = [];
      for (const row of rows) {
        const result = this.db.prepare(
          "UPDATE retention_jobs SET state='claimed',lease_owner=?,lease_fence=lease_fence+1,lease_expires_at=?,updated_at=? " +
          "WHERE job_id=? AND state=? AND lease_fence=?",
        ).run(this.owner, input.leaseExpiresAt < row.expires_at ? input.leaseExpiresAt : row.expires_at,
          now, row.job_id, row.state, row.lease_fence);
        if (result.changes === 1) claimed.push(row.job_id);
      }
      return claimed;
    }).immediate();
  }

  executeClaimed(input: { readonly jobId: string; readonly now: string; readonly cutoff: string }): RetentionReceipt {
    let started = this.now();
    if (!validTimestamp(input.now) || !validTimestamp(input.cutoff)
      || input.now > started || input.cutoff > started) throw new PersonalOsError("E_CLOCK_INVALID");
    let fence: number | undefined;
    try {
      return this.db.transaction(() => {
        started = this.now();
        const job = this.currentLease(input.jobId, started);
        fence = job.lease_fence;
        if (job.policy_cutoff === null || job.policy_cutoff !== input.cutoff) throw new PersonalOsError("E_RETENTION_POLICY");
        const adapter = this.adapters[job.data_class];
        if (adapter === undefined) throw new PersonalOsError("E_RETENTION_ADAPTER");
        const policy: RetentionPolicy = { schema_version: 1, data_class: job.data_class, cutoff: input.cutoff };
        const policy_digest = digest("retention-policy/v2", policy);
        const counts = adapter(this.db, { job_id: input.jobId, now: started, policy, policy_digest });
        validateCounts(counts);
        const completedAt = this.now();
        if (completedAt < started) throw new PersonalOsError("E_CLOCK_INVALID");
        const current = this.currentLease(input.jobId, completedAt);
        if (current.lease_fence !== fence) throw new PersonalOsError("E_RETENTION_CLAIM");
        const body = { ...counts, cutoff: input.cutoff, policy_digest, fence };
        const result_digest = digest("retention-receipt/v1", body);
        const settled = this.db.prepare(
          "UPDATE retention_jobs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE " +
            "job_id=? AND state='claimed' AND lease_owner=? AND lease_fence=?",
        ).run(result_digest, completedAt, input.jobId, this.owner, fence);
        if (settled.changes !== 1) throw new PersonalOsError("E_RETENTION_CLAIM");
        return { ...body, result_digest };
      }).immediate();
    } catch (error) {
      const failure = error instanceof PersonalOsError ? error : new PersonalOsError("E_RETENTION_ADAPTER");
      // The transaction already rolled back adapter changes and any partial completion.
      if (fence !== undefined) this.db.prepare(
        "UPDATE retention_jobs SET state='failed',failure_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? " +
          "WHERE job_id=? AND state='claimed' AND lease_owner=? AND lease_fence=?",
      ).run(failure.code, started, input.jobId, this.owner, fence);
      throw failure;
    }
  }

  private now(): string {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new PersonalOsError("E_CLOCK_INVALID");
    return now.toISOString();
  }

  private currentLease(jobId: string, now: string): { data_class: RetentionDataClass; lease_fence: number; policy_cutoff: string | null } {
    const row = this.db.prepare(
      "SELECT data_class,lease_fence,policy_cutoff FROM retention_jobs WHERE job_id=? AND state='claimed' AND lease_owner=? " +
        "AND lease_expires_at>? AND expires_at>? AND updated_at<=? AND not_before<=?",
    ).get(jobId, this.owner, now, now, now, now) as {
      data_class: RetentionDataClass; lease_fence: number; policy_cutoff: string | null;
    } | undefined;
    if (!row) throw new PersonalOsError("E_RETENTION_CLAIM");
    return row;
  }
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`orca-jarvis/${domain}\0`).update(canonicalize(value)).digest("hex")}`;
}
function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateCounts(counts: RetentionCounts): void {
  const keys = ["scanned", "eligible", "deleted", "retained", "error_count"] as const;
  if (!counts || Object.keys(counts).sort().join(",") !== [...keys].sort().join(",")
    || keys.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)
    || counts.error_count !== 0 || counts.eligible > counts.scanned || counts.deleted > counts.eligible
    || counts.deleted + counts.retained !== counts.scanned) throw new PersonalOsError("E_RETENTION_ADAPTER");
}
