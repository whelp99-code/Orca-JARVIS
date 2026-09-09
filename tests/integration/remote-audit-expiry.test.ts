import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { RemoteAuditService } from "../../src/remote-audit-service.js";
import { RetentionRuntime } from "../../src/personal-os-retention.js";

it("settles expired daily jobs conservatively without replaying them or touching other retention jobs", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const previous = "2026-09-09T12:00:00.000Z", now = new Date("2026-09-10T00:00:00.000Z");
    const runtime = new RetentionRuntime(db.db, "fixture", {}, () => new Date(previous));
    const pending = "remote-auth:daily:v1:2026-09-08", claimed = "remote-auth:daily:v1:2026-09-09";
    for (const id of [pending, claimed, "unrelated"]) runtime.createJob({ jobId: id, jobKey: `${id}:limit:1`,
      idempotencyKey: `${id}:limit:1`, dataClass: "audit", createdAt: previous, notBefore: previous,
      expiresAt: now.toISOString(), cutoff: "2025-01-01T00:00:00.000Z" });
    runtime.claimDue({ jobId: claimed, now: previous, leaseExpiresAt: "2026-09-09T12:01:00.000Z" });
    const service = new RemoteAuditService(db.db, 1, () => now);
    const first = service.cycle();
    expect(first).toMatchObject({ status: "completed", expiry_history: {
      scope: "recorded_daily_job_expirations", never_started: 1, outcome_unknown: 1 } });
    const rows = db.db.prepare("SELECT job_id,state,failure_code,lease_owner FROM retention_jobs ORDER BY job_id").all();
    expect(rows).toEqual(expect.arrayContaining([
      { job_id: pending, state: "failed", failure_code: "E_RETENTION_EXPIRED", lease_owner: null },
      { job_id: claimed, state: "uncertain", failure_code: "E_RETENTION_EXPIRED", lease_owner: null },
      { job_id: "unrelated", state: "pending", failure_code: null, lease_owner: null },
    ]));
    const before = db.db.serialize();
    expect(service.cycle()).toEqual(first);
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});

it("limits expiry recovery to 100 daily jobs per cycle", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const at = "2025-01-01T00:00:00.000Z", expiry = "2026-01-01T00:00:00.000Z";
    const runtime = new RetentionRuntime(db.db, "fixture", {}, () => new Date(at));
    for (let i = 0; i < 102; i++) {
      const date = new Date(Date.parse(at) + i * 86400000).toISOString().slice(0, 10);
      const id = `remote-auth:daily:v1:${date}`;
      runtime.createJob({ jobId: id, jobKey: `${id}:limit:1`, idempotencyKey: `${id}:limit:1`,
        dataClass: "audit", createdAt: at, notBefore: at, expiresAt: expiry, cutoff: at });
    }
    const service = new RemoteAuditService(db.db, 1, () => new Date("2026-09-10T00:00:00.000Z"));
    service.cycle();
    const count = () => db.db.prepare("SELECT count(*) n FROM retention_jobs WHERE failure_code='E_RETENTION_EXPIRED'").get();
    expect(count()).toEqual({ n: 100 });
    service.cycle();
    expect(count()).toEqual({ n: 102 });
  } finally { db.close(); }
});
