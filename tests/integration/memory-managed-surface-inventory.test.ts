import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb } from "../../src/db.js";
import { persistForbiddenContentIdentities } from "../../src/memory-forbidden-content.js";
import {
  providerSurfaceInventory,
  reingressGuardObservations,
} from "../fixtures/memory-surface-observations.js";
import { tempDb } from "../helpers.js";

type Scanner = {
  scan(input: {
    readonly provider: ReturnType<typeof providerSurfaceInventory>;
    readonly guards: ReturnType<typeof reingressGuardObservations>;
  }): Promise<{ readonly expected_surface_count: 70; readonly observed_surface_count: 70;
    readonly entries: readonly Readonly<Record<string, unknown>>[];
    readonly omission_count: 0; readonly error_count: 0 }>;
};
type ScannerConstructor = new (input: {
  readonly authority: AuthorityDb;
  readonly layout: {
    readonly spool_root: string; readonly state_root: string; readonly dist_root: string;
    readonly backup_root: string; readonly restore_root: string;
  };
}) => Scanner;

function isScannerConstructor(value: unknown): value is ScannerConstructor {
  return typeof value === "function";
}

describe("complete managed memory surface inventory", () => {
  it("merges forty provider, twenty local, and ten reingress observations", async () => {
    // Given: all mandatory isolated runtime roots and exact signed provider/guard observations.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-inventory-"));
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "release", "dist"), backup_root: join(root, "backups"),
        restore_root: join(root, "restore") };
      for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
      const constructor = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      expect(isScannerConstructor(constructor)).toBe(true);
      if (!isScannerConstructor(constructor)) return;
      const scanner = new constructor({ authority: db, layout });

      // When: the non-public complete inventory constructor merges all owners.
      const inventory = await scanner.scan({ provider: providerSurfaceInventory(),
        guards: reingressGuardObservations() });

      // Then: no caller-selected row can disappear and the stable dist row is present once.
      expect(inventory).toMatchObject({ expected_surface_count: 70, observed_surface_count: 70,
        omission_count: 0, error_count: 0 });
      expect(inventory.entries.filter(row => row["surface_id"] === "dist_runtime_fixtures"))
        .toHaveLength(1);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when an unmanifested runtime file survives in dist fixtures", async () => {
    // Given: every managed root exists but one runtime-random file remains under dist.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-inventory-canary-"));
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "dist"), backup_root: join(root, "backups"),
        restore_root: join(root, "restore") };
      for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(layout.dist_root, "retained-runtime.bin"), "runtime-random-canary", { mode: 0o600 });
      const constructor = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      expect(isScannerConstructor(constructor)).toBe(true);
      if (!isScannerConstructor(constructor)) return;

      // When/Then: the fixed inventory reports the unknown file as fatal instead of synthesizing zero.
      await expect(new constructor({ authority: db, layout }).scan({
        provider: providerSurfaceInventory(), guards: reingressGuardObservations(),
      })).rejects.toMatchObject({ code: "MEMORY_SURFACE_INVENTORY_INCOMPLETE" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["state", "remote-auth"])("fails closed when forbidden bytes remain in %s", async surface => {
    // Given: a content-free forbidden identity and the matching bytes in a managed state file.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-inventory-match-"));
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "dist"), backup_root: join(root, "backups"),
        restore_root: join(root, "restore") };
      for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
      const canary = Buffer.from("forbidden-runtime-state-canary");
      db.db.pragma("foreign_keys=OFF");
      persistForbiddenContentIdentities(db, { purge_id: "purge:test", material: [canary],
        observed_at: "2026-08-31T00:00:00.000Z" });
      db.db.pragma("foreign_keys=ON");
      if (surface === "state") writeFileSync(join(layout.state_root, "retained.json"), Buffer.concat([
        Buffer.from("prefix:"), canary, Buffer.from(":suffix"),
      ]), { mode: 0o600 });
      else db.db.prepare(`INSERT INTO remote_auth_retention_authorizations_v2
        (authorization_id,job_id,fence,cutoff,state,authorization_digest,created_at)
        VALUES(?,'fixture',1,'2025-01-01T00:00:00.000Z','completed','sha256:fixture','2026-09-09T00:00:00.000Z')`)
        .run(canary.toString());
      const constructor = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      expect(isScannerConstructor(constructor)).toBe(true);
      if (!isScannerConstructor(constructor)) return;

      // When/Then: measured bytes produce a fatal match instead of a synthesized zero.
      await expect(new constructor({ authority: db, layout }).scan({
        provider: providerSurfaceInventory(), guards: reingressGuardObservations(),
      })).rejects.toMatchObject({ code: "MEMORY_SURFACE_INVENTORY_INCOMPLETE" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when any mandatory local root is missing", async () => {
    // Given: a layout whose fixed restore root is absent.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-inventory-missing-"));
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "dist"), backup_root: join(root, "backups"),
        restore_root: join(root, "missing") };
      for (const path of [layout.spool_root, layout.state_root, layout.dist_root, layout.backup_root]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      }
      const constructor = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      expect(isScannerConstructor(constructor)).toBe(true);
      if (!isScannerConstructor(constructor)) return;

      // When/Then: scanning records the omission as fatal rather than filtering the row.
      await expect(new constructor({ authority: db, layout }).scan({
        provider: providerSurfaceInventory(), guards: reingressGuardObservations(),
      })).rejects.toMatchObject({ code: "MEMORY_SURFACE_INVENTORY_INCOMPLETE" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
