import { afterEach, describe, expect, it } from "vitest";
import { PersonalOsRuntime } from "../../src/personal-os-runtime.js";
import { closePersonalDb, personalDb, T0, T1, T2, T3, T5 } from "./personal-operations-test-helpers.js";
import type { AuthorityDb } from "../../src/index.js";
import type { RetentionAdapterContext } from "../../src/personal-os-retention.js";

const open: AuthorityDb[] = [];

afterEach(() => {
  for (const db of open.splice(0)) closePersonalDb(db);
});

describe("PersonalOsRuntime retention owner", () => {
  it("bounds claims and caps leases at job expiry without accepting a future clock", async () => {
    const db = await personalDb(); open.push(db);
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(T1) });
    for (let i = 0; i < 101; i++) runtime.retention.createJob({ jobId: `batch-${i}`, jobKey: `batch-${i}`,
      idempotencyKey: `batch-${i}`, dataClass: "notification", notBefore: T0, expiresAt: T2, createdAt: T0 });
    expect(() => runtime.retention.claimDue({ now: T2, leaseExpiresAt: T3 })).toThrow("E_CLOCK_INVALID");
    expect(runtime.retention.claimDue({ now: T1, leaseExpiresAt: T3 })).toHaveLength(100);
    expect(db.db.prepare("SELECT DISTINCT lease_expires_at FROM retention_jobs WHERE state='claimed'").all())
      .toEqual([{ lease_expires_at: T2 }]);
    expect(runtime.retention.claimDue({ now: T1, leaseExpiresAt: T3 })).toHaveLength(1);
  });

  it("rolls all claims back when one job update fails", async () => {
    const db = await personalDb(); open.push(db);
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(T1) });
    for (const id of ["a", "b"]) runtime.retention.createJob({ jobId: id, jobKey: id, idempotencyKey: id,
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    db.db.exec("CREATE TRIGGER retention_test_abort BEFORE UPDATE ON retention_jobs WHEN NEW.job_id='b' " +
      "BEGIN SELECT RAISE(ABORT,'claim test failure'); END");
    expect(() => runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 })).toThrow("claim test failure");
    expect(db.db.prepare("SELECT DISTINCT state,lease_fence FROM retention_jobs").all())
      .toEqual([{ state: "pending", lease_fence: 0 }]);
  });

  it("reclaims an expired process lease with a higher fence and rejects the old executor", async () => {
    const db = await personalDb(); open.push(db);
    let now = T1; let calls = 0;
    const adapters = { notification: () => {
      calls++; return { scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 };
    } };
    const first = new PersonalOsRuntime({ db: db.db, now: () => new Date(now), adapters });
    first.retention.createJob({ jobId: "restart", jobKey: "restart", idempotencyKey: "restart",
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    expect(first.retention.claimDue({ now: T1, leaseExpiresAt: T2 })).toEqual(["restart"]);
    const second = new PersonalOsRuntime({ db: db.db, now: () => new Date(now), adapters });
    expect(second.retention.claimDue({ now: T1, leaseExpiresAt: T2 })).toEqual([]);
    now = T2;
    expect(second.retention.claimDue({ now: T2, leaseExpiresAt: T3 })).toEqual(["restart"]);
    expect(() => first.retention.executeClaimed({ jobId: "restart", now: T2, cutoff: T0 })).toThrow("E_RETENTION_CLAIM");
    expect(second.retention.executeClaimed({ jobId: "restart", now: T2, cutoff: T0 }).fence).toBe(2);
    expect(calls).toBe(1);
  });

  it("does not report completion when the data class has no adapter", async () => {
    const db = await personalDb();
    open.push(db);
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(T1) });
    runtime.retention.createJob({ jobId: "missing", jobKey: "missing", idempotencyKey: "missing",
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
    expect(() => runtime.retention.executeClaimed({ jobId: "missing", now: T1, cutoff: T0 }))
      .toThrow("E_RETENTION_ADAPTER");
    expect(db.db.prepare("SELECT state,failure_code,result_digest FROM retention_jobs WHERE job_id='missing'").get())
      .toEqual({ state: "failed", failure_code: "E_RETENTION_ADAPTER", result_digest: null });
  });

  it("claims a due job, executes the named adapter, and settles a content-free receipt", async () => {
    // Given
    const db = await personalDb();
    open.push(db);
    db.db.exec("CREATE TABLE retention_purge_demo(id TEXT PRIMARY KEY, data_class TEXT NOT NULL, expired INTEGER NOT NULL)");
    db.db.prepare("INSERT INTO retention_purge_demo(id, data_class, expired) VALUES(?,?,?)").run("keep", "notification", 0);
    db.db.prepare("INSERT INTO retention_purge_demo(id, data_class, expired) VALUES(?,?,?)").run("drop", "notification", 1);
    let context: RetentionAdapterContext | undefined;
    const runtime = new PersonalOsRuntime({
      db: db.db,
      now: () => new Date(T1),
      adapters: {
        notification: (database, input) => {
          context = input;
          const scanned = database.prepare("SELECT COUNT(*) AS n FROM retention_purge_demo").get() as { n: number };
          const eligible = database.prepare("SELECT COUNT(*) AS n FROM retention_purge_demo WHERE expired=1").get() as { n: number };
          const deleted = database.prepare("DELETE FROM retention_purge_demo WHERE expired=1").run().changes;
          const retained = database.prepare("SELECT COUNT(*) AS n FROM retention_purge_demo").get() as { n: number };
          return {
            scanned: scanned.n,
            eligible: eligible.n,
            deleted,
            retained: retained.n,
            error_count: 0,
          };
        },
      },
    });
    runtime.retention.createJob({
      jobId: "ret:due",
      jobKey: "notification:2026-08-28",
      idempotencyKey: "idem:retention:due",
      dataClass: "notification",
      notBefore: T0,
      expiresAt: T5,
      createdAt: T0,
    });

    // When
    const claimed = runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
    const settled = runtime.retention.executeClaimed({ jobId: "ret:due", now: T1, cutoff: T0 });

    // Then
    expect(runtime.owner).toBe("PersonalOsRuntime/RetentionRuntime");
    expect(claimed).toEqual(["ret:due"]);
    expect(settled.eligible).toBe(1);
    expect(settled.deleted).toBe(1);
    expect(settled.retained).toBe(1);
    expect(context).toEqual({ job_id: "ret:due", now: T1,
      policy: { schema_version: 1, data_class: "notification", cutoff: T0 }, policy_digest: settled.policy_digest });
    expect(settled.result_digest.startsWith("sha256:")).toBe(true);
    expect(settled).not.toHaveProperty("content");
    expect(settled).not.toHaveProperty("payload");
    expect(db.db.prepare("SELECT state FROM retention_jobs WHERE job_id=?").get("ret:due")).toEqual({ state: "completed" });
    expect(db.db.prepare("SELECT id FROM retention_purge_demo ORDER BY id").all()).toEqual([{ id: "keep" }]);
    expect(() => runtime.retention.executeClaimed({ jobId: "ret:due", now: T1, cutoff: T0 })).toThrow("E_RETENTION_CLAIM");
  });

  it("completes an actually empty scan and binds the cutoff into its policy digest", async () => {
    const db = await personalDb();
    open.push(db);
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(T1), adapters: {
      notification: () => ({ scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 }),
    } });
    const digests: string[] = [];
    for (const cutoff of [T0, T1]) {
      runtime.retention.createJob({ jobId: cutoff, jobKey: cutoff, idempotencyKey: cutoff,
        dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
      runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
      const result = runtime.retention.executeClaimed({ jobId: cutoff, now: T1, cutoff });
      expect(result).toMatchObject({ scanned: 0, deleted: 0, error_count: 0 });
      digests.push(result.policy_digest);
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  it.each(["throw", "counts", "settlement", "expiry"])("rolls back deletion after %s failure", async mode => {
    const db = await personalDb();
    open.push(db);
    db.db.exec("CREATE TABLE retention_rollback_demo(id TEXT PRIMARY KEY); INSERT INTO retention_rollback_demo VALUES('keep-on-failure')");
    let now = T1;
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(now), adapters: {
      notification: database => {
        database.prepare("DELETE FROM retention_rollback_demo").run();
        if (mode === "throw") throw new Error("injected adapter failure");
        if (mode === "expiry") now = T2;
        return { scanned: 1, eligible: 1, deleted: 1, retained: 0, error_count: mode === "counts" ? 1 : 0 };
      },
    } });
    runtime.retention.createJob({ jobId: mode, jobKey: mode, idempotencyKey: mode,
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
    if (mode === "settlement") db.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON retention_jobs
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END`);
    const code = mode === "expiry" ? "E_RETENTION_CLAIM" : "E_RETENTION_ADAPTER";
    expect(() => runtime.retention.executeClaimed({ jobId: mode, now: T1, cutoff: T0 })).toThrow(code);
    expect(db.db.prepare("SELECT id FROM retention_rollback_demo").all()).toEqual([{ id: "keep-on-failure" }]);
    expect(db.db.prepare("SELECT state,failure_code,result_digest FROM retention_jobs WHERE job_id=?").get(mode))
      .toEqual({ state: "failed", failure_code: code, result_digest: null });
  });

  it("rejects expired and foreign claims before calling an adapter", async () => {
    const db = await personalDb();
    open.push(db);
    let now = T1;
    let calls = 0;
    const adapters = { notification: () => {
      calls++;
      return { scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 };
    } };
    const first = new PersonalOsRuntime({ db: db.db, now: () => new Date(now), adapters });
    const second = new PersonalOsRuntime({ db: db.db, now: () => new Date(now), adapters });
    first.retention.createJob({ jobId: "owned", jobKey: "owned", idempotencyKey: "owned",
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    first.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
    expect(() => second.retention.executeClaimed({ jobId: "owned", now: T1, cutoff: T0 })).toThrow("E_RETENTION_CLAIM");
    now = T2;
    expect(() => first.retention.executeClaimed({ jobId: "owned", now: T2, cutoff: T0 })).toThrow("E_RETENTION_CLAIM");
    expect(calls).toBe(0);
  });

  it("rechecks time after acquiring the SQLite transaction before invoking the adapter", async () => {
    const db = await personalDb();
    open.push(db);
    let reads = 0;
    let calls = 0;
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(reads++ === 0 ? T1 : T2), adapters: {
      notification: () => {
        calls++;
        return { scanned: 0, eligible: 0, deleted: 0, retained: 0, error_count: 0 };
      },
    } });
    runtime.retention.createJob({ jobId: "waited", jobKey: "waited", idempotencyKey: "waited",
      dataClass: "notification", notBefore: T0, expiresAt: T5, createdAt: T0 });
    runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });
    reads = 0;
    expect(() => runtime.retention.executeClaimed({ jobId: "waited", now: T1, cutoff: T0 })).toThrow("E_RETENTION_CLAIM");
    expect(calls).toBe(0);
  });

  it("does not claim a premature job and does not double-complete a settled job", async () => {
    // Given
    const db = await personalDb();
    open.push(db);
    const runtime = new PersonalOsRuntime({ db: db.db, now: () => new Date(T1) });
    runtime.retention.createJob({
      jobId: "ret:early",
      jobKey: "notification:early",
      idempotencyKey: "idem:retention:early",
      dataClass: "notification",
      notBefore: T2,
      expiresAt: T5,
      createdAt: T0,
    });

    // When
    const claimed = runtime.retention.claimDue({ now: T1, leaseExpiresAt: T2 });

    // Then
    expect(claimed).toEqual([]);
    expect(db.db.prepare("SELECT state FROM retention_jobs WHERE job_id=?").get("ret:early")).toEqual({ state: "pending" });
  });
});
