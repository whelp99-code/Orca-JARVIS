import { dirname } from "node:path";
import { rmSync } from "node:fs";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { controlRequestPage, pendingControlSummary, parseControlPage } from "../../src/dashboard/control-request-read.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { initialized } from "../helpers.js";

const AT = new Date("2026-09-08T00:00:00.000Z");
let db: Awaited<ReturnType<typeof initialized>> | undefined;
afterEach(() => { if (db) { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); db = undefined; } });
async function setup(firstId?: string) {
  db = await initialized();
  const control = new ControlPlane(db);
  for (let i = 0; i < 25; i++) control.stage({ schema_version: 1, request_id: i === 0 && firstId !== undefined ? firstId : `req-${String(i).padStart(3, "0")}`,
    action: "workflow.start", action_level: 2, target: { environment: "local" },
    args: { run_id: `run-${i}`, loop_id: "agentops-default", correlation_id: `task-${i}`,
      input: { private_payload: "not-returned" }, budget: { deadline: "2026-09-08T00:01:00.000Z", max_steps: 1, max_attempts_per_node: 1 } },
    reversible: true, requested_by: "test-operator", requested_at: AT.toISOString(),
    expires_at: "2026-09-08T01:00:00.000Z", nonce: `nonce-${i}` }, AT);
  return db;
}

describe("current actionable command pages", () => {
  it("counts beyond the preview, preserves legacy membership, and seeks without duplicates", async () => {
    const current = await setup();
    const model = new DashboardReadModel(current);
    const before = current.db.prepare("SELECT total_changes() AS n").get();
    const summary = pendingControlSummary(current, AT);
    expect(summary.total).toBe(25); expect(summary.items).toHaveLength(20);
    const first = model.listControlRequests(AT, { limit: 10 });
    expect(first.page).toMatchObject({ total: 25, returned: 10, has_more: true });
    const secondInput = parseControlPage(`/api/v1/control/requests?limit=10&cursor=${first.page?.next_cursor}`);
    if (typeof secondInput === "string") throw new Error(secondInput);
    const second = model.listControlRequests(AT, secondInput);
    const thirdInput = parseControlPage(`/api/v1/control/requests?limit=10&cursor=${second.page?.next_cursor}`);
    if (typeof thirdInput === "string") throw new Error(thirdInput);
    const third = model.listControlRequests(AT, thirdInput);
    const ids = [...first.items, ...second.items, ...third.items].map(item => item.request_id);
    expect(ids).toEqual(model.listControlRequests(AT).items.map(item => item.request_id));
    expect(new Set(ids).size).toBe(25);
    expect(third.page).toEqual({ total: 25, limit: 10, returned: 5, has_more: false, next_cursor: null });
    expect(JSON.stringify(first)).not.toContain("private_payload");
    expect(current.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("applies current state and quarantine after the cursor anchor has disappeared", async () => {
    const current = await setup();
    const first = controlRequestPage(current, AT, { limit: 10 });
    const next = parseControlPage(`/?limit=10&cursor=${first.page?.next_cursor}`);
    if (typeof next === "string") throw new Error(next);
    const authority = new MemoryProjectionAuthority(current);
    for (const id of ["req-009", "req-010", "req-011"]) authority.quarantineUnresolved({
      kind: "control_payload", id, component_id: id }, AT);
    current.db.prepare("UPDATE control_command_requests SET state='completed' WHERE request_id='req-012'").run();
    const page = controlRequestPage(current, AT, next);
    expect(page.page?.total).toBe(21);
    expect(page.items[0]?.request_id).toBe("req-013");
    expect(page.items).toHaveLength(10);
    expect(pendingControlSummary(current, AT).total).toBe(21);
    expect(controlRequestPage(current, AT).items).toHaveLength(21);
    current.db.prepare("UPDATE memory_projection_authority SET rebuild_state='pending' WHERE singleton_id=1").run();
    const before = current.db.prepare("SELECT total_changes() AS n").get();
    expect(() => controlRequestPage(current, AT, next)).toThrow("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
    expect(current.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("validates page inputs at HTTP without mutating authority", async () => {
    const current = await setup();
    const server = createDashboardServer({ db: current, staticRoot: dirname(current.filename), host: "127.0.0.1", port: 0, clock: () => AT });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const before = current.db.prepare("SELECT total_changes() AS n").get();
    try {
      for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "cursor=abc", "limit=10&cursor=", "limit=10&cursor=***", "limit=10&cursor=e30"]) {
        const response = await request(`${origin}/api/v1/control/requests?${query}`);
        expect(response.statusCode, query).toBe(400); await response.body.dump();
      }
      const response = await request(`${origin}/api/v1/control/requests?limit=10`);
      expect(response.statusCode).toBe(200);
      expect(await response.body.json()).toMatchObject({ page: { limit: 10, returned: 10, total: 25 } });
      const stale = Buffer.from(JSON.stringify(["9223372036854775807", "0".repeat(64)])).toString("base64url");
      const changed = await request(`${origin}/api/v1/control/requests?limit=10&cursor=${stale}`);
      expect(changed.statusCode).toBe(409);
      expect(await changed.body.json()).toMatchObject({ error: { code: "CONTROL_PAGE_STALE" } });
      expect(current.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { server.close(); }
  });

  it("roundtrips long identifiers with a bounded cursor and rejects removed or replaced anchors", async () => {
    const longId = "a".repeat(4096);
    const current = await setup(longId);
    const first = controlRequestPage(current, AT, { limit: 1 });
    expect(first.items[0]?.request_id).toBe(longId);
    expect(first.page!.next_cursor!.length).toBeLessThan(200);
    const next = parseControlPage(`/?limit=1&cursor=${first.page!.next_cursor}`);
    if (typeof next === "string") throw new Error(next);
    expect(controlRequestPage(current, AT, next).items[0]?.request_id).toBe("req-001");
    current.db.prepare("UPDATE control_command_requests SET rowid=rowid+100000 WHERE request_id=?").run(longId);
    expect(() => controlRequestPage(current, AT, next)).toThrow("CONTROL_PAGE_STALE");
  });
});
