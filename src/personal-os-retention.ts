import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { PersonalOsError } from "./personal-os-errors.js";

export const RETENTION_DATA_CLASSES = [
  "observation",
  "context",
  "recommendation",
  "notification",
  "memory_candidate",
  "audit",
  "delete",
] as const;

export type RetentionDataClass = (typeof RETENTION_DATA_CLASSES)[number];

export type RetentionCounts = {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly retained: number;
  readonly error_count: number;
};

export type RetentionAdapter = (db: Database) => RetentionCounts;
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
};

const EMPTY: RetentionCounts = { scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 };

export class RetentionRuntime {
  constructor(
    private readonly db: Database,
    private readonly owner: string,
    private readonly adapters: RetentionAdapterMap,
  ) {}

  createJob(input: RetentionJobInput): void {
    this.db.prepare(
      "INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
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
    );
  }

  claimDue(input: { readonly now: string; readonly leaseExpiresAt: string }): readonly string[] {
    const rows = this.db.prepare(
      "SELECT job_id FROM retention_jobs WHERE state='pending' AND julianday(?)>=julianday(not_before) AND julianday(?)<julianday(expires_at) ORDER BY job_id",
    ).all(input.now, input.now) as readonly { readonly job_id: string }[];
    const claimed: string[] = [];
    for (const row of rows) {
      const result = this.db.prepare(
        "UPDATE retention_jobs SET state='claimed',lease_owner=?,lease_fence=1,lease_expires_at=?,updated_at=? WHERE job_id=? AND state='pending'",
      ).run(this.owner, input.leaseExpiresAt, input.now, row.job_id);
      if (result.changes === 1) claimed.push(row.job_id);
    }
    return claimed;
  }

  executeClaimed(input: { readonly jobId: string; readonly now: string; readonly cutoff: string }): RetentionReceipt {
    const job = this.db.prepare(
      "SELECT data_class,lease_fence FROM retention_jobs WHERE job_id=? AND state='claimed' AND lease_owner=?",
    ).get(input.jobId, this.owner) as { readonly data_class: RetentionDataClass; readonly lease_fence: number } | undefined;
    if (!job) throw new PersonalOsError("E_RETENTION_CLAIM");
    const adapter = this.adapters[job.data_class];
    const counts = adapter === undefined ? EMPTY : adapter(this.db);
    const policy_digest = `sha256:${createHash("sha256").update("orca-jarvis/retention-policy/v1\0").update(job.data_class).digest("hex")}`;
    const body = {
      scanned: counts.scanned,
      eligible: counts.eligible,
      deleted: counts.deleted,
      retained: counts.retained,
      error_count: counts.error_count,
      cutoff: input.cutoff,
      policy_digest,
      fence: job.lease_fence,
    };
    const result_digest = `sha256:${createHash("sha256").update("orca-jarvis/retention-receipt/v1\0").update(canonicalize(body)).digest("hex")}`;
    const settled = this.db.prepare(
      "UPDATE retention_jobs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=? AND state='claimed' AND lease_owner=? AND lease_fence=?",
    ).run(result_digest, input.now, input.jobId, this.owner, job.lease_fence);
    if (settled.changes !== 1) throw new PersonalOsError("E_RETENTION_CLAIM");
    return { ...body, result_digest };
  }
}
