import { describe, expect, it } from "vitest";
import {
  PRODUCTION_BACKUP_ROOT,
  PRODUCTION_BACKUP_SOURCE,
  type BackupResult,
} from "../../src/personal-os-backup.js";
import { runBackupCli } from "../../src/personal-os-backup-cli.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";

const RESULT: BackupResult = {
  destPath: "/fixture/backup.sqlite",
  sha256: "a".repeat(64),
  bytes: 1024,
  quick_check: "ok",
};

describe("personal-OS backup CLI", () => {
  it("dispatches an explicit production request only to the production backup lane", async () => {
    const lines: string[] = [];
    let productionInput: { readonly sourcePath: string; readonly backupRoot: string; readonly now?: Date } | undefined;
    const result = await runBackupCli([
      "--db", PRODUCTION_BACKUP_SOURCE,
      "--backup-root", PRODUCTION_BACKUP_ROOT,
      "--production",
    ], {
      productionBackup: async input => { productionInput = input; return RESULT; },
      isolatedBackup: async () => { throw new Error("isolated lane must not run"); },
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      write: line => { lines.push(line); },
    });

    expect(result).toBe(RESULT);
    expect(productionInput).toEqual({
      sourcePath: PRODUCTION_BACKUP_SOURCE,
      backupRoot: PRODUCTION_BACKUP_ROOT,
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ ok: true, mode: "production", quick_check: "ok" });
  });

  it("keeps rehearsal backup requests on the isolated lane", async () => {
    let isolatedInput: { readonly sourcePath: string; readonly destPath: string } | undefined;
    await runBackupCli(["--db", "/dev/shm/source.sqlite", "--backup-root", "/dev/shm/backups"], {
      isolatedBackup: async input => { isolatedInput = input; return RESULT; },
      productionBackup: async () => { throw new Error("production lane must not run"); },
      write: () => undefined,
    });
    expect(isolatedInput).toEqual({
      sourcePath: "/dev/shm/source.sqlite",
      destPath: "/dev/shm/backups/jarvis-rehearsal.sqlite",
    });
  });

  it("rejects incomplete or unknown command lines", async () => {
    await expect(runBackupCli(["--production"], { write: () => undefined })).rejects.toBeInstanceOf(PersonalOsError);
    await expect(runBackupCli(["--unknown"], { write: () => undefined })).rejects.toMatchObject({ code: "E_USAGE" });
  });
});
