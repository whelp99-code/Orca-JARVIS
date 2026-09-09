import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { execute } from "../../src/cli.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV } from "../../src/personal-os-cycle-channel.js";

it("executes one configured daily batch, replays after restart and resumes on the next UTC date", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-service-")), path = join(root, "db.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate();
    const seed = db.db.prepare(`INSERT INTO personal_operation_audit_events
      (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at,
      outcome,reason_code,counter_disposition,origin_digest,rp_id_digest)
      VALUES(?,'remote.rejected','challenge','s','c',?,'2025-01-01T00:00:00.000Z',
        'rejected','expired','not_checked','o','r')`);
    seed.run("one", "sha256:one"); seed.run("two", "sha256:two");
    const args = ["service", "once", "--db", path, "--remote-audit-retention-limit", "1"];
    const clock = () => new Date("2026-09-09T12:00:00.000Z");
    const first = await execute(args, { clock });
    expect(first).toMatchObject({ state: "disconnected", remote_audit_retention: { status: "completed", limit: 1 } });
    expect((await execute(args, { clock })).remote_audit_retention).toEqual(first.remote_audit_retention);
    expect(db.db.prepare("SELECT COUNT(*) n FROM remote_audit_retired_events").get()).toEqual({ n: 1 });
    expect(await execute([...args.slice(0, -1), "2"], { clock }))
      .toMatchObject({ remote_audit_retention: { status: "error" } });
    expect(await execute(args, { clock: () => new Date("2026-09-10T12:00:00.000Z") }))
      .toMatchObject({ remote_audit_retention: { status: "completed" } });
    expect(db.db.prepare("SELECT COUNT(*) n FROM remote_audit_retired_events").get()).toEqual({ n: 2 });
    expect(db.db.prepare("SELECT COUNT(*) n FROM retention_jobs").get()).toEqual({ n: 2 });
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("rejects invalid limits and staged-channel activation before creating retention jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-service-invalid-")), path = join(root, "db.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate();
    for (const limit of ["0", "1001", "1.5"]) await expect(execute([
      "service", "once", "--db", path, "--remote-audit-retention-limit", limit]))
      .rejects.toMatchObject({ code: "REMOTE_AUDIT_RETENTION_CONFIG_INVALID" });
    vi.stubEnv(PERSONAL_OS_CONTROL_CHANNEL_ENV, "fixture");
    await expect(execute(["service", "once", "--db", path, "--remote-audit-retention-limit", "1"]))
      .rejects.toMatchObject({ code: "REMOTE_AUDIT_RETENTION_CONFIG_INVALID" });
    expect(db.db.prepare("SELECT COUNT(*) n FROM retention_jobs").get()).toEqual({ n: 0 });
  } finally { vi.unstubAllEnvs(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("keeps a failed batch rolled back and does not silently retry it after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-service-failure-")), path = join(root, "db.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate();
    db.db.prepare(`INSERT INTO personal_operation_audit_events
      (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at,
      outcome,reason_code,counter_disposition,origin_digest,rp_id_digest)
      VALUES('failure','remote.rejected','challenge','s','c','sha256:failure','2025-01-01T00:00:00.000Z',
        'rejected','expired','not_checked','o','r')`).run();
    db.db.exec(`CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON personal_operation_audit_events
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    const args = ["service", "once", "--db", path, "--remote-audit-retention-limit", "1"];
    const dependencies = { clock: () => new Date("2026-09-09T12:00:00.000Z") };
    expect(await execute(args, dependencies)).toMatchObject({ remote_audit_retention: {
      status: "error", state: "failed", code: "E_RETENTION_ADAPTER", result_digest: null,
    } });
    db.db.exec("DROP TRIGGER fixture_delete_failure");
    expect(await execute(args, dependencies)).toMatchObject({ remote_audit_retention: {
      status: "error", state: "failed", code: "E_RETENTION_ADAPTER",
    } });
    expect(db.db.prepare("SELECT COUNT(*) n FROM remote_audit_retired_events").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) n FROM personal_operation_audit_events WHERE event_id='failure'").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT lease_fence FROM retention_jobs").get()).toEqual({ lease_fence: 1 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("waits for a live lease and recovers the same daily job after its owner expires", async () => {
  const { RetentionRuntime } = await import("../../src/personal-os-retention.js");
  const { RemoteAuditService } = await import("../../src/remote-audit-service.js");
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-service-lease-")), path = join(root, "db.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate();
    let now = new Date("2026-09-09T12:00:00.000Z");
    const runtime = new RetentionRuntime(db.db, "dead-owner", {}, () => now);
    const jobId = "remote-auth:daily:v1:2026-09-09", key = `${jobId}:limit:1`;
    runtime.createJob({ jobId, jobKey: key, idempotencyKey: key, dataClass: "audit", createdAt: now.toISOString(),
      notBefore: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z", cutoff: "2025-09-09T00:00:00.000Z" });
    expect(runtime.claimDue({ jobId, now: now.toISOString(), leaseExpiresAt: "2026-09-09T12:01:00.000Z" })).toEqual([jobId]);
    const service = new RemoteAuditService(db.db, 1, () => now);
    expect(service.cycle()).toMatchObject({ status: "pending", state: "claimed", result_digest: null });
    now = new Date("2026-09-09T12:01:00.000Z");
    expect(service.cycle()).toMatchObject({ status: "completed", state: "completed" });
    expect(db.db.prepare("SELECT lease_fence FROM retention_jobs").get()).toEqual({ lease_fence: 2 });
    expect(new RemoteAuditService(db.db, 1, () => now).cycle()).toMatchObject({ status: "completed" });
    expect(db.db.prepare("SELECT lease_fence FROM retention_jobs").get()).toEqual({ lease_fence: 2 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
