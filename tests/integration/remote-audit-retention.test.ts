import { afterEach, expect, it } from "vitest";
import { mkdtempSync, cpSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../../src/db.js";
import { readRemoteAuditHistory } from "../../src/remote-audit-history.js";
import { RetentionRuntime } from "../../src/personal-os-retention.js";
import { createRemoteAuditRetentionAdapter } from "../../src/remote-audit-retention.js";

const opened: AuthorityDb[] = [];
const NOW = "2026-09-09T00:00:00.000Z", CUTOFF = "2025-09-09T00:00:00.000Z";
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
async function fixture() {
  const db = new AuthorityDb(":memory:", "migrations"); opened.push(db); await db.migrate();
  return db.db;
}
function seed(db: AuthorityDb["db"], id: string, at: string, remote = true) {
  db.prepare(`INSERT INTO personal_operation_audit_events
    (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at,
     outcome,reason_code,counter_disposition,origin_digest,rp_id_digest)
    VALUES(?,?,'challenge','private-subject','private-correlation',?,?,
      'rejected','expired','not_checked','private-origin','private-rp')`)
    .run(id, remote ? "remote.rejected" : "local.event", `sha256:${id}`, at);
}
function run(db: AuthorityDb["db"], id: string, clock = () => new Date(NOW), cutoff = CUTOFF) {
  const runtime = new RetentionRuntime(db, "test", { audit: createRemoteAuditRetentionAdapter(1) }, clock);
  runtime.createJob({ jobId: id, jobKey: `remote-auth:${id}`, idempotencyKey: id, dataClass: "audit",
    createdAt: NOW, notBefore: NOW, expiresAt: "2026-09-09T00:05:00.000Z", cutoff });
  runtime.claimDue({ now: NOW, leaseExpiresAt: "2026-09-09T00:02:00.000Z" });
  return () => runtime.executeClaimed({ jobId: id, now: NOW, cutoff });
}
it("retires one old remote row, preserves outcome and prevents identity replay", async () => {
  const db = await fixture();
  seed(db, "old-a", "2025-09-08T00:00:00.000Z"); seed(db, "old-b", "2025-09-08T00:00:00.000Z");
  seed(db, "boundary", CUTOFF); seed(db, "local", "2025-09-08T00:00:00.000Z", false);
  expect(run(db, "first")()).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, retained: 0 });
  expect(db.prepare("SELECT event_id FROM personal_operation_audit_events ORDER BY event_id").all())
    .toEqual([{ event_id: "boundary" }, { event_id: "local" }, { event_id: "old-b" }]);
  const retired = db.prepare("SELECT * FROM remote_audit_retired_events").get();
  expect(retired).toMatchObject({ event_id: "old-a", outcome: "rejected", reason_code: "expired" });
  expect(JSON.stringify(retired)).not.toContain("private-");
  expect(() => seed(db, "old-a", NOW)).toThrow("remote audit identity retired");
  expect(() => db.prepare(`INSERT INTO personal_operation_audit_events
    (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at)
    VALUES('different','local.event','challenge','s','c','sha256:old-a',?)`).run(NOW))
    .toThrow("remote audit identity retired");
  expect(() => db.prepare("DELETE FROM remote_audit_retired_events").run()).toThrow("immutable retired remote audit");
  expect(run(db, "second")()).toMatchObject({ deleted: 1 });
  expect(run(db, "empty")()).toMatchObject({ scanned: 0, deleted: 0 });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
it("rejects a cutoff that violates the 365-day policy", async () => {
  const db = await fixture(); seed(db, "old", "2025-09-08T00:00:00.000Z");
  expect(run(db, "policy", undefined, "2025-09-10T00:00:00.000Z")).toThrow("E_RETENTION_POLICY");
  expect(db.prepare("SELECT COUNT(*) AS n FROM remote_audit_retired_events").get()).toEqual({ n: 0 });
});
it("rolls back audit retirement and authorization if the lease expires at settlement", async () => {
  const db = await fixture(); seed(db, "old", "2025-09-08T00:00:00.000Z");
  let calls = 0;
  const execute = run(db, "expiry", () => new Date(++calls < 4 ? NOW : "2026-09-09T00:03:00.000Z"));
  expect(execute).toThrow("E_RETENTION_CLAIM");
  expect(db.prepare("SELECT COUNT(*) AS n FROM personal_operation_audit_events").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM remote_audit_retired_events").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM remote_auth_retention_authorizations_v2").get()).toEqual({ n: 0 });
});
it.each(["remote.rejected", "REMOTE.rejected"])("requires retirement evidence for %s with legacy authorization", async eventType => {
  const db = await fixture(); seed(db, "old", "2025-09-08T00:00:00.000Z");
  if (eventType !== "remote.rejected") {
    // Immutable rows are seeded with their final case through the same production schema.
    db.prepare(`INSERT INTO personal_operation_audit_events
      (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at,
       outcome,reason_code,counter_disposition,origin_digest,rp_id_digest)
      VALUES('upper',?,'challenge','s','c','sha256:upper','2025-09-08T00:00:00.000Z',
        'rejected','expired','not_checked','o','r')`).run(eventType);
  }
  run(db, "guard");
  db.prepare(`INSERT INTO remote_auth_retention_authorizations_v2
    (authorization_id,job_id,fence,cutoff,state,authorization_digest,created_at)
    VALUES('a','guard',1,?,'applying','sha256:guard',?)`).run(CUTOFF, NOW);
  expect(() => db.prepare("DELETE FROM personal_operation_audit_events WHERE event_id=?")
    .run(eventType === "remote.rejected" ? "old" : "upper"))
    .toThrow("remote audit retirement evidence required");
  const insert = db.prepare(`INSERT INTO remote_audit_retired_events
    VALUES('old','sha256:old','remote.rejected','rejected','expired','2025-09-08T00:00:00.000Z','a')`);
  db.prepare("UPDATE remote_auth_retention_authorizations_v2 SET fence=2 WHERE authorization_id='a'").run();
  expect(() => insert.run()).toThrow("remote audit retirement evidence required");
  expect(db.prepare("SELECT COUNT(*) AS n FROM personal_operation_audit_events").get())
    .toEqual({ n: eventType === "remote.rejected" ? 1 : 2 });
});
it("rolls back all retirement writes when authorization settlement fails", async () => {
  const db = await fixture(); seed(db, "old", "2025-09-08T00:00:00.000Z");
  db.exec(`CREATE TRIGGER fail_retirement_settlement BEFORE UPDATE ON remote_auth_retention_authorizations_v2
    WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
  expect(run(db, "failure")).toThrow("E_RETENTION_ADAPTER");
  for (const table of ["remote_audit_retired_events", "remote_auth_retention_authorizations_v2"]) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(db.prepare("SELECT COUNT(*) AS n FROM personal_operation_audit_events").get()).toEqual({ n: 1 });
});

it("retires an actual pre-056 remote audit after upgrading without inventing outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-upgrade-"));
  const sql = join(root, "migrations");
  let db: AuthorityDb | undefined;
  try {
    cpSync("migrations", sql, { recursive: true });
    for (const name of readdirSync(sql)) if (Number(name.slice(0, 3)) >= 56) rmSync(join(sql, name));
    db = new AuthorityDb(join(root, "authority.sqlite"), sql); await db.migrate();
    db.db.exec(`INSERT INTO personal_operation_audit_events
      (event_id,event_type,subject_kind,subject_id,correlation_id,event_digest,created_at)
      VALUES('legacy','remote.assertion.consumed','challenge','c','c','sha256:legacy','2025-09-08T00:00:00.000Z')`);
    db.close(); db = new AuthorityDb(join(root, "authority.sqlite"), "migrations"); await db.migrate();
    expect(run(db.db, "upgrade")()).toMatchObject({ deleted: 1 });
    expect(db.db.prepare("SELECT event_id,outcome,reason_code FROM remote_audit_retired_events").get())
      .toEqual({ event_id: "legacy", outcome: null, reason_code: null });
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});

it("reads minimal active and retired history without writes and rejects altered authorization", async () => {
  const db = await fixture(); seed(db, "history", "2025-09-08T00:00:00.000Z");
  const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  let before = changes();
  const active = readRemoteAuditHistory(db, "history");
  expect(active).toMatchObject({ state: "active", event: { event_id: "history", outcome: "rejected" } });
  expect(readRemoteAuditHistory(db, "missing")).toEqual({ state: "not_found" });
  expect(changes()).toBe(before);
  run(db, "history-job")(); before = changes();
  const retired = readRemoteAuditHistory(db, "history");
  expect(retired).toMatchObject({ state: "retired", event: active.event, evidence: "verified_retirement_bindings" });
  expect(JSON.stringify(retired)).not.toContain("private-"); expect(changes()).toBe(before);
  db.prepare("UPDATE remote_auth_retention_authorizations_v2 SET authorization_digest='sha256:changed'").run();
  before = changes();
  expect(() => readRemoteAuditHistory(db, "history")).toThrow("REMOTE_AUDIT_HISTORY_INVALID");
  expect(changes()).toBe(before);
});

it("opens and reopens non-WAL audit history read-only without converting journal mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-audit-readonly-"));
  const path = join(root, "authority.sqlite");
  let db: AuthorityDb | undefined;
  try {
    db = new AuthorityDb(path, "migrations"); await db.migrate();
    seed(db.db, "read-only", "2025-09-08T00:00:00.000Z");
    db.db.pragma("journal_mode=DELETE"); db.close();
    const before = readFileSync(path);
    db = new AuthorityDb(path, "migrations", { readonly: true, fileMustExist: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) db.reopen();
      await db.assertMigrationsReady();
      expect(db.db.readonly).toBe(true);
      expect(db.db.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(readRemoteAuditHistory(db.db, "read-only")).toMatchObject({ state: "active" });
      expect(() => db!.db.exec("CREATE TABLE forbidden_write(id TEXT)")).toThrow();
      db.close(); expect(readFileSync(path).equals(before)).toBe(true);
    }
  } finally { if (db?.db.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});
