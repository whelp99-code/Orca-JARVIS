import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";

type Message = Record<string, unknown>;
function worker(filename: string) {
  const child = fork(join(process.cwd(), "tests/fixtures/gjc-runtime-worker.mjs"), [filename], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  let waiting: { type: string; resolve: (value: Message) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  child.on("message", raw => {
    const message = raw as Message;
    if (message.type === "error") {
      failure = new Error(String(message.code));
      waiting?.reject(failure);
    } else if (waiting && waiting.type === message.type) {
      const { resolve } = waiting;
      waiting = undefined;
      resolve(message);
    } else messages.push(message);
  });
  child.on("error", error => { failure = error; waiting?.reject(error); });
  child.on("exit", code => {
    failure = new Error(`worker exited: ${code}`);
    waiting?.reject(failure);
  });
  return {
    send: (message: Message) => child.send(message),
    next: async (type: string): Promise<Message> => {
      if (failure) throw failure;
      const found = messages.findIndex(message => message.type === type);
      if (found >= 0) return messages.splice(found, 1)[0]!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Message>((resolve, reject) => {
          waiting = { type, resolve, reject };
          timer = setTimeout(() => reject(new Error(`worker event timeout: ${type}`)), 10_000);
        });
      } finally { clearTimeout(timer); waiting = undefined; }
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}

describe("GJC runtime across real processes and one WAL database", () => {
  it("releases the lease between two actual CLI one-shot invocations", async () => {
    const root = mkdtempSync(join(tmpdir(), "gjc-cli-owners-"));
    const filename = join(root, "authority.sqlite");
    const db = new AuthorityDb(filename);
    try {
      await db.migrate();
      let prior: { owner: string; fence: number } | undefined;
      for (let index = 0; index < 2; index++) {
        const { stdout } = await promisify(execFile)(process.execPath, [
          "dist/src/cli.js", "service", "once", "--db", filename,
        ], { cwd: process.cwd(), timeout: 10_000 });
        expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: "service.once", state: "disconnected" });
        const lease = db.db.prepare("SELECT owner,fence,expires_at FROM gjc_runtime_leases WHERE id=1").get() as {
          owner: string; fence: number; expires_at: string;
        };
        expect(Date.parse(lease.expires_at)).toBeLessThanOrEqual(Date.now());
        if (prior) {
          expect(lease.owner).not.toBe(prior.owner);
          expect(lease.fence).toBeGreaterThan(prior.fence);
        }
        prior = lease;
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps the first owner's claim, then admits a successor after explicit release", async () => {
    const root = mkdtempSync(join(tmpdir(), "gjc-owners-"));
    const filename = join(root, "authority.sqlite");
    const db = new AuthorityDb(filename);
    const workers: ReturnType<typeof worker>[] = [];
    const started = "2026-09-07T00:00:00.000Z";
    try {
      await db.migrate();
      db.configureGjc(process.cwd(), "s", true);
      for (const turn of ["t1", "t2"])
        db.createGjcIntent("sync", { session_id: "s", turn_id: turn }, turn, undefined, started);
      const first = worker(filename);
      const second = worker(filename);
      workers.push(first, second);
      const [a, b] = await Promise.all([first.next("ready"), second.next("ready")]);
      expect(a.pid).not.toBe(b.pid);
      first.send({ action: "run", now: started });
      await first.next("call");
      const lease = db.db.prepare("SELECT owner,fence FROM gjc_runtime_leases WHERE id=1").get() as { fence: number };
      second.send({ action: "run", now: started });
      expect(await second.next("result")).toMatchObject({ state: "leased", processed: null });
      expect(db.db.prepare("SELECT owner,fence FROM gjc_runtime_leases WHERE id=1").get()).toEqual(lease);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intents WHERE state='claimed'").get()).toEqual({ n: 1 });
      first.send({ action: "resume" });
      expect(await first.next("result")).toMatchObject({ state: "completed" });
      first.send({ action: "close" });
      await first.next("released");
      second.send({ action: "run", now: "2026-09-07T00:00:01.000Z" });
      await second.next("call");
      second.send({ action: "resume" });
      expect(await second.next("result")).toMatchObject({ state: "completed" });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intents WHERE state='completed'").get()).toEqual({ n: 2 });
      expect((db.db.prepare("SELECT fence FROM gjc_runtime_leases WHERE id=1").get() as { fence: number }).fence)
        .toBeGreaterThan(lease.fence);
    } finally {
      await Promise.all(workers.map(item => item.stop()));
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
