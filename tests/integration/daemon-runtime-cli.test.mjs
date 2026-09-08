import { clearTimeout, setTimeout } from "node:timers";
import process from "node:process";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
const cli = resolve("dist/src/cli.js");
const fixture = resolve("tests/fixtures/daemon-runtime-worker.mjs");
const migrationCount = readdirSync(resolve("migrations")).filter(file => file.endsWith(".sql")).length;
function command(filename, args = ["runtime", "identity"]) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, "--db", filename], {
    cwd: tmpdir(), encoding: "utf8", timeout: 10_000 }));
}
function message(child, action) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); child.off("message", received); child.off("error", failed); child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    };
    const received = value => finish(null, value);
    const failed = error => finish(error);
    const exited = code => finish(new Error(`fixture exited ${code}`));
    const timer = setTimeout(() => finish(new Error("fixture event timeout")), 10_000);
    child.once("message", received); child.once("error", failed); child.once("exit", exited);
    if (action) child.send({ action });
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
const stored = db => db.db.prepare("SELECT * FROM gjc_runtime_identity").get();
describe("built CLI daemon identity", () => {
  it("does not create a missing DB and does not migrate an old DB", () => {
    const root = mkdtempSync(join(tmpdir(), "identity-cli-")); const filename = join(root, "authority.sqlite");
    try {
      const missing = command(filename);
      expect(missing).toMatchObject({ ok: true, command: "runtime.identity", observer: {
        build: { status: "matched" }, database: { status: "unavailable" } }, daemon: { status: "unknown", reason: "unavailable" } });
      expect(readdirSync(root)).toEqual([]);
      const legacy = new Database(filename); legacy.exec("CREATE TABLE original(value TEXT)"); legacy.close();
      const bytes = readFileSync(filename); const old = command(filename);
      expect(old.observer.database.status).toBe("unavailable"); expect(old.daemon.status).toBe("unknown");
      expect(readFileSync(filename)).toEqual(bytes); expect(readdirSync(root)).toEqual(["authority.sqlite"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps the completed service.once identity separate from the later status/identity CLI PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "identity-once-")); const filename = join(root, "authority.sqlite");
    const db = new AuthorityDb(filename);
    try {
      await db.migrate(); expect(command(filename, ["service", "once"]).ok).toBe(true);
      const row = stored(db); const result = command(filename);
      expect(result.observer.database).toMatchObject({ status: "matched", applied_migrations: migrationCount });
      expect(result.daemon).toMatchObject({ status: "inactive", reason: "lease_expired", snapshot: { build: { status: "matched" } } });
      expect(result.daemon.snapshot.process.pid).not.toBe(result.observer.process.pid);
      expect(command(filename, ["service", "status"]).daemon_identity).toMatchObject({ status: "inactive", snapshot: result.daemon.snapshot });
      expect(stored(db)).toEqual(row); expect(JSON.stringify(result)).not.toContain(root);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== "linux")("observes a different live daemon, preserves its lease against a competitor, and detects its exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "identity-process-")); const filename = join(root, "authority.sqlite");
    const db = new AuthorityDb(filename); const children = [];
    try {
      await db.migrate();
      const first = fork(fixture, [filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(first);
      expect(await message(first)).toMatchObject({ ready: true });
      expect(stored(db)).toBeUndefined(); expect(await message(first, "once")).toMatchObject({ result: { state: "disconnected" } });
      const row = stored(db); const active = command(filename);
      expect(active.daemon).toMatchObject({ status: "active", snapshot: { process: { pid: first.pid }, build: { status: "matched" } } });
      expect(active.observer.process.pid).not.toBe(first.pid);
      const second = fork(fixture, [filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(second);
      await message(second); expect(await message(second, "once")).toMatchObject({ result: { state: "leased" } });
      expect(stored(db)).toEqual(row);
      await stop(first);
      expect(command(filename).daemon).toMatchObject({ status: "stale", reason: "process_missing" });
      db.db.prepare("UPDATE gjc_runtime_leases SET expires_at=?").run(new Date(Date.now() - 1).toISOString());
      expect(await message(second, "once")).toMatchObject({ result: { state: "disconnected" } });
      const successor = command(filename).daemon;
      expect(successor).toMatchObject({ status: "active", snapshot: { process: { pid: second.pid } } });
      expect(successor.lease.fence).toBeGreaterThan(active.daemon.lease.fence);
      expect(await message(second, "release")).toEqual({ released: true });
      expect(command(filename).daemon.status).toBe("inactive");
    } finally { await Promise.all(children.map(stop)); db.close(); rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
