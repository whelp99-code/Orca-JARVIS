import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(process.cwd(), "dist/src/cli.js");
const dbArtifacts = (db: string, root: string) => [db, `${db}-wal`, `${db}-shm`, join(root, "jarvis-authority.sqlite"), join(root, "jarvis-authority.sqlite-wal"), join(root, "jarvis-authority.sqlite-shm")];

describe("CLI help", () => {
  it.each([
    [["--help"]],
    [["-h"]],
    [["help"]],
    [["team", "--help"]],
    [["team", "propose", "--help"]],
  ])("%j exits before opening the authority database", args => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-cli-help-")); const db = join(root, "authority.sqlite");
    try {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, JARVIS_DB: db }, encoding: "utf8", timeout: 5000 });
      expect({ status: result.status, signal: result.signal, spawnError: result.error?.message, dbArtifacts: dbArtifacts(db, root).filter(existsSync), stderr: result.stderr.trim() }).toMatchObject({ status: 0, signal: null, spawnError: undefined, dbArtifacts: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("executes through the production current symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-cli-symlink-"));
    const db = join(root, "authority.sqlite");
    const current = join(root, "current");
    try {
      symlinkSync(process.cwd(), current, "dir");
      const result = spawnSync(process.execPath, [join(current, "dist/src/cli.js"), "--help"], {
        cwd: root,
        env: { ...process.env, JARVIS_DB: db },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result).toMatchObject({ status: 0, signal: null });
      expect(result.stdout).toContain('{"version":1,"ok":true,"command":"help"}');
      expect(dbArtifacts(db, root).filter(existsSync)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
