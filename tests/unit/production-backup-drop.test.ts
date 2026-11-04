import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupProductionSqlite, productionBackupRoot, productionBackupSource } from "../../src/personal-os-backup.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { runProductionBackup } from "../../src/production-backup-drop.js";

const HELPER = "ops/authority/production-backup-exec.sh";
const INJECTED_UID = 960;
const STATE_ROOT = "/var/lib/jarvis-svc/state/orca-jarvis";
const REAL_NODE = process.execPath;
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
    const dest = "/tmp/jarvis-backup-nonroot.sqlite";
    writeFileSync(dest, "");
    chmodSync(dest, 0o600);
    try {
      await runProductionBackup({
        uid: 1000,
        stateRoot: STATE_ROOT,
        command: COMMAND,
        execFile: async (file, args) => {
          seen.file = file;
          seen.args = args;
          return { stdout: JSON.stringify({ ok: true, destPath: dest }), stderr: "" };
        },
        stat: () => ({ uid: 1000, mode: 0o100600 }),
      });
      expect(seen.file).toBe(COMMAND[0]);
      expect(seen.args).toEqual(COMMAND.slice(1));
    } finally {
      rmSync(dest, { force: true });
    }
  });

  it("the publish helper passes the caller uid and checks the CLI result path", () => {
    const root = mkdtempSync("/tmp/jarvis-backup-drop-");
    chmodSync(root, 0o755);
    const bin = join(root, "bin");
    const log = "/tmp/jarvis-backup-cli-node.log";
    const dest = "/tmp/jarvis-backup-cli-result.sqlite";
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 0; exit 0; fi\nexit 1\n");
    writeFileSync(join(bin, "backup-child"), "#!/bin/sh\n: > /tmp/jarvis-backup-cli-result.sqlite\nchmod 600 /tmp/jarvis-backup-cli-result.sqlite\nprintf '%s\\n' '{\"ok\":true,\"destPath\":\"/tmp/jarvis-backup-cli-result.sqlite\"}'\nexit 0\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "backup-child"), 0o755);
    const child = join(bin, "backup-child");
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `cd ${JSON.stringify(process.cwd())}`,
      `source ${HELPER}`,
      `run_production_backup ${JSON.stringify(child)} --production`,
    ].join("\n")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        JARVIS_BACKUP_ARGV_LOG: log,
        JARVIS_BACKUP_NODE_BIN: REAL_NODE,
        JARVIS_STATE_ROOT: STATE_ROOT,
      },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      const recorded = readFileSync(log, "utf8");
      expect(recorded).toContain("dist/src/production-backup-drop.js --uid 0");
      expect(recorded).toContain(`-- ${child} --production`);
      expect(recorded).not.toContain("--experimental-strip-types");
      expect(result.stdout).toContain(dest);
    } finally {
      spawnSync("sudo", ["-n", "rm", "-f", dest]);
      rmSync(log, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI path rejects a result file whose mode is not 600", () => {
    const root = mkdtempSync("/tmp/jarvis-backup-drop-");
    chmodSync(root, 0o755);
    const bin = join(root, "bin");
    const dest = "/tmp/jarvis-backup-cli-mode.sqlite";
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 0; exit 0; fi\nexit 1\n");
    writeFileSync(join(bin, "backup-child"), "#!/bin/sh\n: > /tmp/jarvis-backup-cli-mode.sqlite\nchmod 644 /tmp/jarvis-backup-cli-mode.sqlite\nprintf '%s\\n' '{\"ok\":true,\"destPath\":\"/tmp/jarvis-backup-cli-mode.sqlite\"}'\nexit 0\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "backup-child"), 0o755);
    const child = join(bin, "backup-child");
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `cd ${JSON.stringify(process.cwd())}`,
      `source ${HELPER}`,
      `run_production_backup ${JSON.stringify(child)} --production`,
    ].join("\n")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, JARVIS_BACKUP_NODE_BIN: REAL_NODE, JARVIS_STATE_ROOT: STATE_ROOT },
    });
    try {
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("BACKUP_FILE_OWNER");
    } finally {
      spawnSync("sudo", ["-n", "rm", "-f", dest]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stat uid that is not the injected service uid", async () => {
    const dest = "/tmp/jarvis-backup-cli-uid.sqlite";
    writeFileSync(dest, "");
    chmodSync(dest, 0o600);
    try {
      await expect(runProductionBackup({
        uid: 0,
        stateRoot: STATE_ROOT,
        command: COMMAND,
        execFile: async () => ({ stdout: JSON.stringify({ ok: true, destPath: dest }), stderr: "" }),
        stat: () => ({ uid: 0, mode: 0o100600 }),
      })).rejects.toThrow("BACKUP_FILE_OWNER");
    } finally {
      rmSync(dest, { force: true });
    }
  });

  it("the CLI path forwards child stderr and exit code", () => {
    const root = mkdtempSync("/tmp/jarvis-backup-drop-");
    chmodSync(root, 0o755);
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 0; exit 0; fi\nexit 1\n");
    writeFileSync(join(bin, "backup-child"), "#!/bin/sh\nprintf '%s\\n' 'E_BACKUP_PATH' >&2\nexit 17\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "backup-child"), 0o755);
    const child = join(bin, "backup-child");
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `cd ${JSON.stringify(process.cwd())}`,
      `source ${HELPER}`,
      `run_production_backup ${JSON.stringify(child)} --production`,
    ].join("\n")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, JARVIS_BACKUP_NODE_BIN: REAL_NODE, JARVIS_STATE_ROOT: STATE_ROOT },
    });
    try {
      expect(result.status).toBe(17);
      expect(result.stderr).toContain("E_BACKUP_PATH");
      expect(result.stderr).not.toContain("BACKUP_COMMAND_FAILED");
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
