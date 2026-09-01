import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

type Scanner = {
  scan(input: {
    readonly provider: { readonly manifest_digest: string; readonly catalog_rows: 40;
      readonly signature_verified: true };
    readonly guards: Readonly<Record<string, string>>;
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

const GUARDS = Object.fromEntries([
  "sb_remember", "legacy_stable_import", "inbox_done", "all_connectors", "compile_brief",
  "manual_pipeline", "export", "backup_import_restore_rollback", "duplicate_alias",
  "stale_process_generation",
].map(name => [name, `sha256:${"a".repeat(64)}`]));

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
      writeFileSync(join(layout.dist_root, "runtime.json"), "{}\n", { mode: 0o600 });
      const constructor = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      expect(isScannerConstructor(constructor)).toBe(true);
      if (!isScannerConstructor(constructor)) return;
      const scanner = new constructor({ authority: db, layout });

      // When: the non-public complete inventory constructor merges all owners.
      const inventory = await scanner.scan({ provider: { manifest_digest: `sha256:${"a".repeat(64)}`,
        catalog_rows: 40, signature_verified: true }, guards: GUARDS });

      // Then: no caller-selected row can disappear and the stable dist row is present once.
      expect(inventory).toMatchObject({ expected_surface_count: 70, observed_surface_count: 70,
        omission_count: 0, error_count: 0 });
      expect(inventory.entries.filter(row => row["surface_id"] === "dist_runtime_fixtures"))
        .toHaveLength(1);
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
        provider: { manifest_digest: `sha256:${"a".repeat(64)}`,
          catalog_rows: 40, signature_verified: true }, guards: GUARDS,
      })).rejects.toMatchObject({ code: "MEMORY_SURFACE_INVENTORY_INCOMPLETE" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
