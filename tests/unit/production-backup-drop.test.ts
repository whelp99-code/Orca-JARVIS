import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupProductionSqlite, productionBackupRoot, productionBackupSource } from "../../src/personal-os-backup.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { runProductionBackup } from "../../ops/authority/production-backup-exec.mjs";

const HELPER = "ops/authority/production-backup-exec.sh";
const INJECTED_UID = 960;
const STATE_ROOT = "/var/lib/jarvis-svc/state/orca-jarvis";
const COMMAND = ["/usr/bin/node", "personal-os-backup-cli.js", "--db", "/tmp/db", "--backup-root", "/tmp/backups", "--production"];

describe("production backup drop", () => {
  it("uid 0 publish runs the production backup as jarvis-svc", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const dest = join(scratch, "backup.sqlite");
    const seen: { file?: string; args?: readonly string[] } = {};
    try {
      await runProductionBackup({
        uid: 0,
        stateRoot: STATE_ROOT,
        command: COMMAND,
        destPath: dest,
        expectedUid: INJECTED_UID,
        execFile: async (file, args) => {
          seen.file = file;
          seen.args = args;
          writeFileSync(dest, "");
          chmodSync(dest, 0o600);
        },
        stat: path => ({ uid: INJECTED_UID, mode: statSync(path).mode }),
      });
      expect(seen.file).toBe("/usr/bin/sudo");
      expect(seen.args).toEqual([
        "-n", "-u", "jarvis-svc", "--", "/usr/bin/env", `JARVIS_STATE_ROOT=${STATE_ROOT}`, ...COMMAND,
      ]);
      expect(statSync(dest).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a child file whose mode is not 600", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const dest = join(scratch, "backup.sqlite");
    try {
      await expect(runProductionBackup({
        uid: 0,
        stateRoot: STATE_ROOT,
        command: COMMAND,
        destPath: dest,
        expectedUid: INJECTED_UID,
        execFile: async () => {
          writeFileSync(dest, "");
          chmodSync(dest, 0o644);
        },
        stat: path => ({ uid: INJECTED_UID, mode: statSync(path).mode }),
      })).rejects.toThrow("BACKUP_FILE_OWNER");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a child file whose uid is not the injected uid", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const dest = join(scratch, "backup.sqlite");
    try {
      await expect(runProductionBackup({
        uid: 0,
        stateRoot: STATE_ROOT,
        command: COMMAND,
        destPath: dest,
        expectedUid: INJECTED_UID,
        execFile: async () => {
          writeFileSync(dest, "");
          chmodSync(dest, 0o600);
        },
        stat: path => ({ uid: 0, mode: statSync(path).mode }),
      })).rejects.toThrow("BACKUP_FILE_OWNER");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a non-root publisher does not call sudo", async () => {
    const seen: { file?: string; args?: readonly string[] } = {};
    await runProductionBackup({
      uid: 1000,
      stateRoot: STATE_ROOT,
      command: COMMAND,
      execFile: async (file, args) => {
        seen.file = file;
        seen.args = args;
      },
    });
    expect(seen.file).toBe(COMMAND[0]);
    expect(seen.args).toEqual(COMMAND.slice(1));
  });

  it("the publish helper passes the caller uid to the runner", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const bin = join(root, "bin");
    const log = join(root, "node.log");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 0; exit 0; fi\nexit 1\n");
    writeFileSync(join(bin, "node"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$NODE_LOG\"\nexit 0\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "node"), 0o755);
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `source ${HELPER}`,
      "run_production_backup /bin/echo backup-child --production",
    ].join("\n")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_BIN: join(bin, "node"),
        NODE_LOG: log,
        JARVIS_STATE_ROOT: STATE_ROOT,
      },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      const recorded = readFileSync(log, "utf8");
      expect(recorded).toContain("production-backup-exec.mjs --uid 0");
      expect(recorded).toContain(`--state-root ${STATE_ROOT} -- /bin/echo backup-child --production`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still rejects a backup root owned by a different uid", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "jarvis-backup-owner-"));
    const stateRoot = join(scratch, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const saved = process.env["JARVIS_STATE_ROOT"];
    process.env["JARVIS_STATE_ROOT"] = stateRoot;
    const source = productionBackupSource();
    const backupRoot = productionBackupRoot();
    writeFileSync(source, "");
    chmodSync(source, 0o600);
    mkdirSync(backupRoot, { mode: 0o700 });
    const changed = spawnSync("sudo", ["-n", "chown", "root:root", backupRoot], { encoding: "utf8" });
    expect(changed.status, changed.stderr).toBe(0);
    try {
      await expect(backupProductionSqlite({ sourcePath: source, backupRoot })).rejects.toBeInstanceOf(PersonalOsError);
      await expect(backupProductionSqlite({ sourcePath: source, backupRoot })).rejects.toMatchObject({
        code: "E_BACKUP_PATH",
      });
    } finally {
      spawnSync("sudo", ["-n", "chown", `${process.getuid?.()}:${process.getgid?.()}`, backupRoot]);
      if (saved === undefined) delete process.env["JARVIS_STATE_ROOT"];
      else process.env["JARVIS_STATE_ROOT"] = saved;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
