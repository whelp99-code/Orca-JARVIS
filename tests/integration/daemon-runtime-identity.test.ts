import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { AuthorityDb } from "../../src/db.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { GjcRuntimeService } from "../../src/service.js";
import { captureDaemonRuntimeIdentity, publishDaemonRuntimeIdentity, readDaemonRuntimeIdentity } from "../../src/daemon-runtime-identity.js";
import type { RuntimeProcessObservation } from "../../src/runtime-process-identity.js";
import { tempDb } from "../helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const db = new AuthorityDb(tempDb()); await db.migrate();
  cleanup.push(() => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); });
  return db;
}
const row = (db: AuthorityDb) => db.db.prepare("SELECT * FROM gjc_runtime_identity").get();
const changes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();
function service(db: AuthorityDb, capture = captureDaemonRuntimeIdentity) {
  const instance = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => { throw new Error("no coordinator calls"); }),
    "identity-test", undefined, () => new Date(), capture);
  cleanup.push(() => instance.close()); return instance;
}
const read = (db: AuthorityDb) => readDaemonRuntimeIdentity(db.db, new Date());

describe.skipIf(process.platform !== "linux")("lease-bound daemon identity", () => {
  it("keeps construction and status read-only without substituting the caller process", async () => {
    const db = await fixture(); let captures = 0;
    const instance = service(db, () => { captures++; return captureDaemonRuntimeIdentity(); });
    const before = changes(db);
    expect(instance.status().daemon_identity).toMatchObject({ status: "unknown", reason: "missing", snapshot: null });
    expect(row(db)).toBeUndefined(); expect(changes(db)).toEqual(before); expect(captures).toBe(0);
  });
  it("publishes on first owned cycle, keeps it fixed, and never lets a competing service overwrite it", async () => {
    const db = await fixture(); let captures = 0;
    const first = service(db, () => { captures++; return captureDaemonRuntimeIdentity(); });
    await first.once(); const saved = row(db);
    expect(read(db)).toMatchObject({ status: "active", snapshot: { process: { pid: process.pid }, build: { status: "missing" } } });
    await first.once(); expect(row(db)).toEqual(saved); expect(captures).toBe(1);
    const competitor = service(db, () => { throw new Error("must not capture without lease"); });
    expect(await competitor.once()).toMatchObject({ state: "leased" }); expect(row(db)).toEqual(saved);
    const before = changes(db); expect(read(db).status).toBe("active"); expect(changes(db)).toEqual(before);
  });
  it("marks release/expiry inactive and republishes the same snapshot with a new fence", async () => {
    const db = await fixture(); let captures = 0;
    const first = service(db, () => { captures++; return captureDaemonRuntimeIdentity(); });
    await first.once(); const original = read(db);
    first.close(); expect(read(db)).toMatchObject({ status: "inactive", reason: "lease_expired" });
    await first.once(); const restarted = read(db);
    expect(restarted.status).toBe("active"); expect(restarted.lease!.fence).toBe(original.lease!.fence + 1);
    expect(restarted.snapshot).toEqual(original.snapshot); expect(captures).toBe(1);
    expect(readDaemonRuntimeIdentity(db.db, new Date(Date.parse(restarted.lease!.expires_at))))
      .toMatchObject({ status: "inactive", reason: "lease_expired" });
  });
  it("rejects fence theft during capture and rolls back partial publication", async () => {
    const db = await fixture(); const snapshot = captureDaemonRuntimeIdentity();
    const stolen = service(db, () => { db.db.prepare("UPDATE gjc_runtime_leases SET fence=fence+1").run(); return snapshot; });
    await expect(stolen.once()).rejects.toMatchObject({ code: "GJC_STALE_LEASE" });
    expect(row(db)).toBeUndefined(); expect(db.db.prepare("SELECT * FROM gjc_runtime_status").get()).toBeUndefined();
    expect(() => publishDaemonRuntimeIdentity(db.db, snapshot, "wrong", 1, new Date().toISOString()))
      .toThrow("GJC_IDENTITY_TRANSACTION_REQUIRED");
  });
  it("does not renew a lease that expired during synchronous build observation", async () => {
    const db = await fixture(); const snapshot = captureDaemonRuntimeIdentity();
    const instance = service(db, () => snapshot);
    const elapsed = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(61_000);
    try { await expect(instance.once()).rejects.toMatchObject({ code: "GJC_STALE_LEASE" }); }
    finally { elapsed.mockRestore(); }
    expect(row(db)).toBeUndefined();
  });
  it("rolls back identity and lease heartbeat if runtime heartbeat publication fails", async () => {
    const db = await fixture();
    db.db.exec("CREATE TRIGGER reject_health BEFORE INSERT ON gjc_runtime_status BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(service(db).once()).rejects.toThrow("fixture"); expect(row(db)).toBeUndefined();
  });
  it.each(["expiry", "stolen-fence", "heartbeat-rollback"] as const)("recaptures after unpublished %s observation", async failure => {
    const db = await fixture(); let captures = 0;
    const original = captureDaemonRuntimeIdentity();
    const instance = service(db, () => {
      captures++;
      if (captures === 1 && failure === "stolen-fence") db.db.prepare("UPDATE gjc_runtime_leases SET fence=fence+1").run();
      return { ...original, build: { ...original.build, source_head: String(captures).padStart(40, "0") } };
    });
    if (failure === "heartbeat-rollback") {
      db.db.exec("CREATE TRIGGER reject_health BEFORE INSERT ON gjc_runtime_status BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    }
    const elapsed = failure === "expiry" ? vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(61_000) : null;
    try { await expect(instance.once()).rejects.toThrow(failure === "heartbeat-rollback" ? "fixture" : "GJC_STALE_LEASE"); }
    finally { elapsed?.mockRestore(); }
    expect(row(db)).toBeUndefined(); expect(captures).toBe(1);
    if (failure === "heartbeat-rollback") db.db.exec("DROP TRIGGER reject_health");
    db.db.prepare("UPDATE gjc_runtime_leases SET expires_at=?").run(new Date(Date.now() - 1).toISOString());
    await instance.once();
    expect(captures).toBe(2);
    expect(read(db)).toMatchObject({ status: "active", snapshot: { build: { source_head: "2".padStart(40, "0") } } });
  });
  it("marks an old snapshot stale while a new lease owner has not published yet", async () => {
    const db = await fixture(); const first = service(db); await first.once(); first.close();
    db.claimGjcRuntimeLease("replacement", new Date().toISOString());
    expect(read(db)).toMatchObject({ status: "stale", reason: "lease_changed" });
  });
  it.each(["missing", "exited", "unavailable"] as const)("classifies process %s without claiming the old build is active", async status => {
    const db = await fixture(); await service(db).once(); const before = changes(db);
    expect(readDaemonRuntimeIdentity(db.db, new Date(), () => ({ status, incarnation: null })))
      .toMatchObject({ status: status === "unavailable" ? "unknown" : "stale",
        reason: status === "unavailable" ? "process_unobservable" : `process_${status}` });
    expect(changes(db)).toEqual(before);
  });
  it.each(["boot_id", "start_token", "pid_namespace"] as const)("does not trust a changed %s", async key => {
    const db = await fixture(); await service(db).once();
    const identity = read(db).snapshot!.incarnation!;
    const process: RuntimeProcessObservation = { status: "running", incarnation: { ...identity, [key]: "changed" } };
    expect(readDaemonRuntimeIdentity(db.db, new Date(), () => process)).toMatchObject({
      status: key === "pid_namespace" ? "unknown" : "stale",
      reason: key === "pid_namespace" ? "namespace_unobservable" : "incarnation_changed" });
  });
  it("reports corrupted snapshots and bad clocks explicitly without leaking stored bytes", async () => {
    const db = await fixture(); await service(db).once();
    expect(readDaemonRuntimeIdentity(db.db, new Date(NaN))).toMatchObject({ status: "unknown", reason: "clock_invalid" });
    db.db.prepare("UPDATE gjc_runtime_identity SET snapshot_json=?").run('{"PRIVATE_MARKER":true}');
    const result = read(db); expect(result).toMatchObject({ status: "unknown", reason: "invalid", snapshot: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MARKER");
  });
  it("does not promote a future heartbeat to an active observation", async () => {
    const db = await fixture(); await service(db).once();
    db.db.prepare("UPDATE gjc_runtime_leases SET heartbeat_at=?").run(new Date(Date.now() + 100_000).toISOString());
    expect(read(db)).toMatchObject({ status: "unknown", reason: "clock_invalid" });
  });
  it("rejects unknown snapshot fields and unavailable legacy DBs without initialization", async () => {
    const db = await fixture(); await service(db).once();
    const snapshot = { ...read(db).snapshot, private_payload: "PRIVATE_MARKER" };
    db.db.prepare("UPDATE gjc_runtime_identity SET snapshot_json=?").run(JSON.stringify(snapshot));
    expect(read(db)).toMatchObject({ status: "unknown", reason: "invalid" });
    db.db.exec("DROP TABLE gjc_runtime_identity"); const before = changes(db);
    expect(read(db)).toMatchObject({ status: "unknown", reason: "unavailable" }); expect(changes(db)).toEqual(before);
  });
});
