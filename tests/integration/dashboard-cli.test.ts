import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { parseDashboardCli } from "../../src/dashboard/main.js";

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
    const child = spawn(process.execPath, [
      MAIN,
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
});
