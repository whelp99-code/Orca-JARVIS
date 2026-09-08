import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { writeCurrentState } from "../../src/state-projection.js";
import * as filesystem from "../../src/secure-filesystem.js";
import { initialized } from "../helpers.js";

describe("state publication lineage gate", () => {
  it("replaces an existing generation and preserves it after a post-rename sync failure", async () => {
    const db = await initialized(); const root = mkdtempSync(join(tmpdir(), "jarvis-state-replace-"));
    try {
      const first = await writeCurrentState(db, root);
      const second = await writeCurrentState(db, root);
      const generations = join(root, ".current-state");
      expect(second.generation).not.toBe(first.generation);
      expect(readlinkSync(join(generations, "current"))).toBe(second.generation);
      const sync = filesystem.syncDirectory;
      vi.spyOn(filesystem, "syncDirectory").mockImplementation(async path => {
        if (path === generations) throw new Error("TEST_SYNC_FAILED");
        await sync(path);
      });
      await expect(writeCurrentState(db, root)).rejects.toThrow("STATE_PROJECTION_OUTCOME_UNCERTAIN");
      const current = readlinkSync(join(generations, "current"));
      expect(current).not.toBe(second.generation);
      expect(JSON.parse(readFileSync(join(generations, current, "CURRENT_STATE.json"), "utf8"))).toMatchObject({ schema_version: 1 });
    } finally { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["before-write", "before-publish"])("preserves the old generation when quarantined %s", async stage => {
    const db = await initialized();
    const root = mkdtempSync(join(tmpdir(), "jarvis-state-lineage-"));
    try {
      const old = await writeCurrentState(db, root);
      const bytes = readFileSync(old.json, "utf8");
      const generations = join(root, ".current-state");
      if (stage === "before-write") {
        const control = new ControlPlane(db); const now = new Date();
        db.db.transaction(() => {
          for (let i = 0; i < 1100; i++) control.stage({ schema_version: 1, request_id: `wide-${i}`,
            action: "state.project", action_level: 1, target: { environment: "local" }, args: {}, reversible: true,
            requested_by: "test", requested_at: now.toISOString(), expires_at: new Date(+now + 600000).toISOString(),
            nonce: `nonce-${i}` }, now);
        }).immediate();
      } else {
        const sync = filesystem.syncDirectory;
        vi.spyOn(filesystem, "syncDirectory").mockImplementation(async path => {
          await sync(path);
          const id = basename(path);
          if (id.startsWith("generation-") && id !== old.generation) {
            new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "state_generation", id, component_id: id }, new Date());
          }
        });
      }
      await expect(writeCurrentState(db, root)).rejects.toThrow("STATE_PROJECTION_SUPPRESSED");
      expect(readlinkSync(join(generations, "current"))).toBe(old.generation);
      expect(readFileSync(old.json, "utf8")).toBe(bytes);
      expect(readdirSync(generations).sort()).toEqual(["current", old.generation].sort());
    } finally { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
