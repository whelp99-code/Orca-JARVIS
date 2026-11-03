import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { backupProductionSqlite, productionBackupRoot, productionBackupSource } from "../../src/personal-os-backup.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";

const HELPER = "ops/authority/production-backup-exec.sh";
const NODE = "/home/jm/.nvm/versions/node/v24.19.0/bin/node";
const CLI = "dist/src/personal-os-backup-cli.js";
describe("production backup drop", () => {
  it("uid 0 publish runs the production backup as jarvis-svc", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const bin = join(root, "bin");
    const log = join(root, "sudo.log");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 0; exit 0; fi\nexec /usr/bin/id \"$@\"\n");
    writeFileSync(join(bin, "sudo"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$SUDO_LOG\"\nexit 0\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    const stateRoot = "/var/lib/jarvis-svc/state/orca-jarvis";
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `source ${HELPER}`,
      "run_production_backup /bin/echo backup-child --db /tmp/db --backup-root /tmp/backups --production",
    ].join("\n")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SUDO_LOG: log,
        JARVIS_STATE_ROOT: stateRoot,
      },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      const recorded = readFileSync(log, "utf8");
      expect(recorded).toContain("-n -u jarvis-svc --");
      expect(recorded).toContain(`JARVIS_STATE_ROOT=${stateRoot}`);
      expect(recorded).toContain("/bin/echo backup-child --db /tmp/db --backup-root /tmp/backups --production");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-root publisher does not call sudo", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-backup-drop-"));
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "id"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then echo 1000; exit 0; fi\nexec /usr/bin/id \"$@\"\n");
    writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 9\n");
    chmodSync(join(bin, "id"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    const result = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `source ${HELPER}`,
      "run_production_backup /bin/echo backup-child",
    ].join("\n")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("backup-child");
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

  it("writes the new backup as jarvis-svc mode 600", () => {
    // The shard temp is mode 0700. jarvis-svc cannot cross it, so the fixture stays on /tmp.
    const scratch = mkdtempSync(join("/tmp", "jarvis-backup-file-"));
    expect(scratch.startsWith("/tmp/")).toBe(true);
    expect(scratch.includes("/var/lib/jarvis-svc")).toBe(false);
    chmodSync(scratch, 0o711);
    const stateRoot = join(scratch, "state");
    const backupRoot = join(stateRoot, "backups");
    const dbPath = join(stateRoot, "jarvis.sqlite");
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    const db = new Database(dbPath);
    db.exec("create table probe(id integer primary key)");
    db.close();
    chmodSync(dbPath, 0o600);
    chmodSync(backupRoot, 0o700);
    const owned = spawnSync("sudo", ["-n", "chown", "-R", "jarvis-svc:jarvis-svc", stateRoot], { encoding: "utf8" });
    expect(owned.status, owned.stderr).toBe(0);
    const cli = join(process.cwd(), CLI);
    const run = spawnSync("sudo", [
      "-n", "bash", "-c",
      [
        "set -euo pipefail",
        `source ${HELPER}`,
        'export JARVIS_STATE_ROOT="$1"',
        'run_production_backup "$2" "$3" --db "$4" --backup-root "$5" --production',
      ].join("\n"),
      "bash", stateRoot, NODE, cli, dbPath, backupRoot,
    ], { encoding: "utf8" });
    try {
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const listed = spawnSync("sudo", ["-n", "find", backupRoot, "-maxdepth", "1", "-type", "f", "-name", "*.sqlite", "-printf", "%u %m\\n"], { encoding: "utf8" });
      expect(listed.status, listed.stderr).toBe(0);
      const rows = listed.stdout.trim().split("\n").filter(Boolean);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe("jarvis-svc 600");
    } finally {
      spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, scratch]);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
