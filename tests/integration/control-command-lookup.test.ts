import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-09-07T00:00:00.000Z");

describe("control command lookup", () => {
  it("reads one command without inspecting unrelated payloads or their visibility", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const control = new ControlPlane(db);
    const visibility = vi.spyOn(MemoryProjectionAuthority.prototype, "isSuppressed");
    try {
      for (let i = 0; i < 100; i++) control.stage({
        schema_version: 1, request_id: `request-${i}`, action: "state.project", action_level: 2,
        target: { environment: "local" }, args: {}, reversible: true, requested_by: "operator",
        requested_at: now.toISOString(), expires_at: "2026-09-07T00:10:00.000Z", nonce: `nonce-${i}`,
      }, now);
      const expected = control.list().find(row => row.request_id === "request-99");
      visibility.mockClear();
      const before = db.db.prepare("SELECT total_changes() AS n").get();
      expect(control.get("request-99")).toEqual(expected);
      expect(visibility).toHaveBeenCalledTimes(1);
      expect(control.get("missing")).toBeUndefined();
      expect(visibility).toHaveBeenCalledTimes(1);
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      expect(db.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM control_command_requests WHERE request_id=?")
        .all("request-99")).toEqual(expect.arrayContaining([
          expect.objectContaining({ detail: expect.stringContaining("USING INDEX") }),
        ]));
    } finally { visibility.mockRestore(); db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });

  it("keeps quarantined commands hidden for both list and direct lookup", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const control = new ControlPlane(db);
      control.stage({
        schema_version: 1, request_id: "hidden", action: "state.project", action_level: 2,
        target: { environment: "local" }, args: {}, reversible: true, requested_by: "operator",
        requested_at: now.toISOString(), expires_at: "2026-09-07T00:10:00.000Z", nonce: "hidden",
      }, now);
      new MemoryProjectionAuthority(db).quarantineUnresolved({
        kind: "control_payload", id: "hidden", component_id: "hidden",
      }, now);
      expect(control.get("hidden")).toBeUndefined();
      expect(control.list()).toEqual([]);
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });
});
