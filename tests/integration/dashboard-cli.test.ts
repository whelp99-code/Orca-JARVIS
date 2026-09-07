import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { parseDashboardCli, startDashboardCli } from "../../src/dashboard/main.js";

const roots = new Set<string>();
const MAIN = join(process.cwd(), "dist/src/dashboard/main.js");
const STATIC = join(process.cwd(), "dist/dashboard");

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("ephemeral port required"));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function migratedDb(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-cli-"));
  roots.add(root);
  mkdirSync(join(root, "static"), { recursive: true });
  writeFileSync(join(root, "static", "index.html"), "<!doctype html><title>JARVIS Control Center</title>");
  const path = join(root, "authority.sqlite");
  const db = new AuthorityDb(path);
  await db.migrate();
  db.close();
  return path;
}

describe("dashboard CLI", () => {
  it("rejects a non-loopback host before opening the database", () => {
    expect(() => parseDashboardCli(["--host", "0.0.0.0", "--port", "4173", "--db", "x", "--static-root", "y"]))
      .toThrow(/LOCAL_SESSION_REQUIRED/);
  });

  it("binds loopback, prints the origin, and serves health", async () => {
    const dbPath = await migratedDb();
    const port = await freePort();
    const alias = join(dirname(dbPath), "current-main.js");
    symlinkSync(MAIN, alias);
    const child = spawn(process.execPath, [
      alias,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--db", dbPath,
      "--static-root", STATIC,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const origin = await new Promise<string>((resolve, reject) => {
      child.once("exit", code => reject(new Error(`cli exited ${String(code)}`)));
      child.stdout.once("data", chunk => resolve(String(chunk).trim()));
    });
    try {
      expect(origin).toBe(`http://127.0.0.1:${String(port)}`);
      const response = await request(`${origin}/api/v1/health`);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(await response.body.text()) as { schema_version: number };
      expect(body.schema_version).toBe(1);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("close", () => resolve()));
    }
  });

  it("injects a production Memory runtime without extra CLI flags", async () => {
    const dbPath = await migratedDb();
    const staticRoot = join(dirname(dbPath), "static");
    let origin = "";
    const runtime = startDashboardCli({ host: "127.0.0.1", port: 0, dbPath, staticRoot },
      line => { origin = line; });
    try {
      const session = await request(`${origin}/api/v1/session`);
      const parsed: unknown = JSON.parse(await session.body.text());
      const token = typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "csrf_token") : undefined;
      if (typeof token !== "string") throw new TypeError("session token required");
      const response = await request(`${origin}/api/v1/memory/status`, {
        headers: { "X-JARVIS-CSRF": token },
      });
      const body: unknown = JSON.parse(await response.body.text());
      const record = typeof body === "object" && body !== null ? body : {};
      expect(Reflect.get(record, "state")).not.toBe("unavailable");
      expect(Reflect.get(record, "contract_schema")).toBe(4);
      expect(Reflect.get(record, "mutations_enabled")).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
