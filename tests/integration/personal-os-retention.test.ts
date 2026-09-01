import { afterEach, describe, expect, it } from "vitest";
import { PersonalOsRuntime } from "../../src/personal-os-runtime.js";
import { closePersonalDb, personalDb, T0, T1, T2, T5 } from "./personal-operations-test-helpers.js";
import type { AuthorityDb } from "../../src/index.js";

const open: AuthorityDb[] = [];

afterEach(() => {
  for (const db of open.splice(0)) closePersonalDb(db);
});

describe("PersonalOsRuntime retention owner", () => {
  it("claims a due job, executes the named adapter, and settles a content-free receipt", async () => {
    // Given
    const db = await personalDb();
    open.push(db);
    db.db.exec("CREATE TABLE retention_purge_demo(id TEXT PRIMARY KEY, data_class TEXT NOT NULL, expired INTEGER NOT NULL)");
    db.db.prepare("INSERT INTO retention_purge_demo(id, data_class, expired) VALUES(?,?,?)").run("keep", "notification", 0);
    db.db.prepare("INSERT INTO retention_purge_demo(id, data_class, expired) VALUES(?,?,?)").run("drop", "notification", 1);
    const runtime = new PersonalOsRuntime({
      db: db.db,
      now: () => new Date(T1),
      adapters: {
        notification: (database) => {
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
    expect(settled.result_digest.startsWith("sha256:")).toBe(true);
    expect(settled).not.toHaveProperty("content");
    expect(settled).not.toHaveProperty("payload");
    expect(db.db.prepare("SELECT state FROM retention_jobs WHERE job_id=?").get("ret:due")).toEqual({ state: "completed" });
    expect(db.db.prepare("SELECT id FROM retention_purge_demo ORDER BY id").all()).toEqual([{ id: "keep" }]);
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
