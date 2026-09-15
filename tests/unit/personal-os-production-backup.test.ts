import { describe, expect, it } from "vitest";
import {
  assertProductionBackupPaths,
  productionBackupRoot,
  productionBackupSource,
  productionBackupDestination,
} from "../../src/personal-os-backup.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";

describe("personal-OS production backup boundary", () => {
  it("accepts only the exact production DB and backup root", () => {
    expect(assertProductionBackupPaths({
      sourcePath: productionBackupSource(),
      backupRoot: productionBackupRoot(),
    })).toEqual({ sourcePath: productionBackupSource(), backupRoot: productionBackupRoot() });

    for (const input of [
      { sourcePath: `${productionBackupSource()}.copy`, backupRoot: productionBackupRoot() },
      { sourcePath: productionBackupSource(), backupRoot: `${productionBackupRoot()}/nested` },
      { sourcePath: "/tmp/jarvis.sqlite", backupRoot: productionBackupRoot() },
    ]) {
      expect(() => assertProductionBackupPaths(input)).toThrow(PersonalOsError);
    }
  });

  it("creates a unique bounded filename under the exact production root", () => {
    const destination = productionBackupDestination(
      new Date("2026-09-03T12:34:56.789Z"),
      Buffer.from("0011223344556677", "hex"),
    );
    expect(destination).toBe(
      "/home/jm/.local/state/orca-jarvis/backups/jarvis-20260903T123456789Z-0011223344556677.sqlite",
    );
    expect(() => productionBackupDestination(new Date("invalid"), Buffer.alloc(8))).toThrow("E_CLOCK_INVALID");
    expect(() => productionBackupDestination(new Date(), Buffer.alloc(7))).toThrow("E_BACKUP_PATH");
  });
});
