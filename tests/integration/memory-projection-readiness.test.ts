import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { request } from "undici";
import { ControlPlane } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { bindStructuredProjection } from "../../src/memory-projection-bindings.js";
import { NotificationDeliveryStore } from "../../src/notification-delivery-store.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { execute } from "../../src/cli.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";

const now = new Date("2026-09-08T00:00:00.000Z");
const unavailable = { inspect: async () => ({ executable: "missing" as const, configuration: "missing" as const,
  contract_digest: null, protocol_version: null, tools: null, schemas_compatible: false,
  status: "unavailable" as const, doctor: "unavailable" as const, handshake: "unavailable" as const,
  read_authorization: "unauthorized" as const, write_authorization: "disabled" as const,
  data_state: "unavailable" as const, refresh: { kind: "missing" as const } }) };

describe("explicit memory projection initialization", () => {
  it("rolls back partial initialization and retries without removing quarantine", async () => {
    const f = await memoryDatabase(); const db = f.authority;
    try {
      db.db.prepare("UPDATE memory_projection_authority SET rebuild_state='failed'").run();
      db.db.exec(`CREATE TRIGGER rebuild_partial BEFORE UPDATE OF rebuild_state ON memory_projection_authority
        WHEN NEW.rebuild_state='rebuilding' BEGIN
          INSERT INTO memory_projection_quarantine(projection_kind,projection_id,component_id,reason_code,detected_at)
          VALUES('context','partial','partial','lineage_unresolved','2026-09-08T00:00:00.000Z'); END;
        CREATE TRIGGER rebuild_failure BEFORE UPDATE OF rebuild_state ON memory_projection_authority
        WHEN NEW.rebuild_state='ready' BEGIN SELECT RAISE(ABORT,'injected rebuild failure'); END;`);
      const authority = new MemoryProjectionAuthority(db);
      expect(() => authority.initialize(now)).toThrow("injected rebuild failure");
      expect(db.db.prepare("SELECT rebuild_state FROM memory_projection_authority").get()).toEqual({ rebuild_state: "failed" });
      expect(db.db.prepare("SELECT * FROM memory_projection_quarantine").all()).toEqual([]);
      db.db.exec("DROP TRIGGER rebuild_partial; DROP TRIGGER rebuild_failure;");
      db.db.prepare(`INSERT INTO memory_projection_quarantine(projection_kind,projection_id,component_id,reason_code,detected_at)
        VALUES('context','hidden','hidden','lineage_unresolved',?)`).run(now.toISOString());
      authority.initialize(now); authority.assertReady();
      expect(authority.isProjectionIdSuppressed("hidden")).toBe(true);
      const before = db.db.prepare("SELECT total_changes() AS n").get();
      authority.initialize(now);
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { closeMemoryDatabase(f); }
  });

  it("rejects pending lineage writes and notification claims before external resource inspection", async () => {
    const f = await memoryDatabase(); const db = f.authority;
    try {
      const projections = new MemoryProjectionAuthority(db);
      db.db.prepare("UPDATE memory_projection_authority SET rebuild_state='pending'").run();
      const before = db.db.prepare("SELECT total_changes() AS n").get();
      const ref = { kind: "context" as const, id: "pending", component_id: "pending" };
      expect(() => projections.bind(ref, [{ target_digest: `sha256:${"a".repeat(64)}` }], now))
        .toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => projections.hasLineage(ref)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => projections.inherit(ref, [ref], now)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => projections.activateForSequence(1)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => bindStructuredProjection(db.db, ref, {}, now)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      let inspected = false;
      const deliveries = new NotificationDeliveryStore({ authority: db, resourceIsCurrent: () => { inspected = true; return true; } });
      expect(() => deliveries.claim(now.toISOString(), "session")).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(inspected).toBe(false);
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { closeMemoryDatabase(f); }
  });

  it("rejects a missing singleton and invalid initialization clock without writes", async () => {
    const f = await memoryDatabase(); const db = f.authority;
    try {
      const authority = new MemoryProjectionAuthority(db);
      let before = db.db.prepare("SELECT total_changes() AS n").get();
      expect(() => authority.initialize(new Date(Number.NaN))).toThrow("MEMORY_PROJECTION_REBUILD_CLOCK_INVALID");
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      db.db.prepare("DELETE FROM memory_projection_authority").run();
      before = db.db.prepare("SELECT total_changes() AS n").get();
      expect(() => authority.initialize(now)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { closeMemoryDatabase(f); }
  });

  it.each(["pending", "failed", "rebuilding"])("keeps %s first reads closed without implicit writes", async state => {
    const f = await memoryDatabase(); const db = f.authority;
    try {
      db.db.prepare("UPDATE memory_projection_authority SET rebuild_state=?").run(state);
      const before = db.db.prepare("SELECT total_changes() AS n").get();
      const projections = new MemoryProjectionAuthority(db);
      const model = new DashboardReadModel(db, unavailable);
      expect(() => projections.assertReady()).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => new ControlPlane(db).list()).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => new ControlPlane(db).get("missing")).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => model.listTasks(20)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(() => model.taskDetail("missing")).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      await expect(model.overview(now)).rejects.toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      expect(db.db.prepare("SELECT rebuild_state FROM memory_projection_authority").get()).toEqual({ rebuild_state: state });
    } finally { closeMemoryDatabase(f); }
  });

  it("returns a content-free 503 on HTTP reads and resumes after an explicit CLI rebuild", async () => {
    const f = await memoryDatabase(); const db = f.authority;
    writeFileSync(join(f.root, "index.html"), "<!doctype html><title>JARVIS</title>");
    new ControlPlane(db).stage({ schema_version: 1, request_id: "visible-command", action: "runbook.execute", action_level: 3,
      target: { environment: "local", runbook_id: "daemon-dead" }, args: { runbook_id: "daemon-dead", args: { dry_run: true } },
      reversible: true, requested_by: "principal:owner", requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(), nonce: "visible-command-nonce" }, now);
    db.db.prepare("UPDATE memory_projection_authority SET rebuild_state='pending'").run();
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    const server = createDashboardServer({ db, staticRoot: f.root, host: "127.0.0.1", port: 0,
      secondBrainProbe: unavailable, clock: () => now });
    const origin = `http://${server.address.host}:${server.address.port}`;
    try {
      for (const path of ["/api/v1/tasks?limit=20", "/api/v1/tasks/visible-command", "/api/v1/control/requests", "/api/v1/overview"]) {
        const response = await request(`${origin}${path}`);
        expect(response.statusCode, path).toBe(503);
        expect(await response.body.json()).toMatchObject({ error: { code: "MEMORY_PROJECTION_AUTHORITY_NOT_READY" } });
      }
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      await expect(execute(["db", "rebuild-projections", "--db", db.filename], { clock: () => now }))
        .resolves.toMatchObject({ ok: true, command: "db.rebuild-projections" });
      const after = db.db.prepare("SELECT total_changes() AS n").get();
      const response = await request(`${origin}/api/v1/tasks?limit=20`);
      expect(response.statusCode).toBe(200);
      expect(await response.body.json()).toMatchObject({ items: [{ task_id: "visible-command" }] });
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(after);
    } finally { server.close(); await server.drain(); closeMemoryDatabase(f); }
  });
});
