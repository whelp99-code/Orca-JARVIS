import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb, DailyLoopStore, EveningCloseoutStore, generateEveningCloseout, parseEveningCloseoutInput } from "../../src/index.js";
import { parseDashboardCli, startDashboardCli } from "../../src/dashboard/main.js";
import { closeoutInput, signer, trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import { parseNativeEveningSourceConfig } from "../../src/evening-native-source.js";

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
  it("wires the real proposal planner without fixture dependencies", async () => {
    const dbPath = await migratedDb();
    let origin = "";
    const runtime = startDashboardCli({ host: "127.0.0.1", port: 0, dbPath,
      staticRoot: join(dirname(dbPath), "static") }, line => { origin = line; });
    const observer = new AuthorityDb(dbPath);
    try {
      const session = await request(`${origin}/api/v1/session`);
      const { csrf_token: token } = JSON.parse(await session.body.text());
      const before = observer.db.prepare("PRAGMA data_version").get();
      const response = await request(`${origin}/api/v1/proposals/preview`, {
        method: "POST", headers: { origin, "content-type": "application/json", "x-jarvis-csrf": token },
        body: JSON.stringify({ schema_version: 1, objective: "Preview from the real entrypoint",
          work_type: "development", completion_evidence: ["HTTP preview"], answers: [],
          constraints: ["no deployment"], requested_capabilities: [] }),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(await response.body.text()).proposal).toMatchObject({ status: "ready",
        requirements: { constraints: ["no deployment"], completion_evidence: ["HTTP preview"] } });
      expect(observer.db.prepare("PRAGMA data_version").get()).toEqual(before);
    } finally { observer.close(); await runtime.close(); }
  });

  it("validates paired closeout trust options before database creation", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-closeout-key-"));
    roots.add(root);
    const dbPath = join(root, "must-not-exist.sqlite");
    const base = ["--host", "127.0.0.1", "--port", "0", "--db", dbPath, "--static-root", root];
    const valid = ["--closeout-key-id", trustedCloseoutKey.key_id,
      "--closeout-public-key-spki", trustedCloseoutKey.public_key_spki];
    expect(parseDashboardCli([...base, ...valid]).trustedCloseoutKey).toEqual(trustedCloseoutKey);
    const source = { repository_identities: [], max_records: 10, max_bytes: 1048576 };
    expect(() => parseNativeEveningSourceConfig({ ...source, repository_identities: new Array(1) })).toThrow();
    const parsedSource = parseNativeEveningSourceConfig(source);
    source.max_records = 20;
    expect(parsedSource.max_records).toBe(10);
    expect(Object.isFrozen(parsedSource.repository_identities)).toBe(true);
    expect(parseDashboardCli([...base, ...valid, "--native-closeout-source", JSON.stringify(source)]).nativeCloseoutSource).toEqual(source);
    for (const args of [[...base, "--native-closeout-source", JSON.stringify(source)],
      [...base, ...valid, "--native-closeout-source", "{"],
      [...base, ...valid, "--native-closeout-source", JSON.stringify({ ...source, max_records: 101 })],
      [...base, ...valid, "--native-closeout-source", " ".repeat(8193)]]) {
      expect(() => parseDashboardCli(args)).toThrow("VALIDATION_ERROR");
    }
    expect(() => startDashboardCli({ host: "127.0.0.1", port: 0, dbPath, staticRoot: root,
      nativeCloseoutSource: source })).toThrow("VALIDATION_ERROR");
    for (const flags of [valid.slice(0, 2), valid.slice(2),
      ["--closeout-key-id", "bad", "--closeout-public-key-spki", "private-or-invalid"]]) {
      const child = spawnSync(process.execPath, [MAIN, ...base, ...flags], { encoding: "utf8", timeout: 10000 });
      expect(child.status).toBe(2);
      expect(child.stderr.trim()).toBe("VALIDATION_ERROR");
      expect(existsSync(dbPath)).toBe(false);
    }
    expect(() => startDashboardCli({ host: "127.0.0.1", port: 0, dbPath, staticRoot: root,
      trustedCloseoutKey: { key_id: "bad", public_key_spki: "invalid" } })).toThrow(/VALIDATION_ERROR/);
    expect(existsSync(dbPath)).toBe(false);
  });
  it("rejects a non-loopback host before opening the database", () => {
    expect(() => parseDashboardCli(["--host", "0.0.0.0", "--port", "4173", "--db", "x", "--static-root", "y"]))
      .toThrow(/LOCAL_SESSION_REQUIRED/);
  });

  it("binds loopback, prints the origin, and serves health", async () => {
    const dbPath = await migratedDb();
    const db = new AuthorityDb(dbPath);
    const at = new Date("2026-08-30T12:00:00.000Z");
    const loop = new DailyLoopStore(db);
    const runId = loop.prepare({ due: { kind: "due", local_date: "2026-08-30", phase: "evening",
      scheduled_at: at.toISOString() }, created_at: at, deadline_at: new Date("2026-08-30T13:00:00.000Z"),
    steps: [{ key: "evening_summary", sequence: 1 }] });
    const claim = loop.claim({ run_id: runId, owner_id: "cli-test-owner", at, lease_ms: 600_000 });
    const correlation = db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string };
    const artifact = generateEveningCloseout(parseEveningCloseoutInput({ ...closeoutInput(),
      run_id: runId, correlation_id: correlation.correlation_id }), signer(at.toISOString()));
    new EveningCloseoutStore(db, trustedCloseoutKey).settle({ claim, artifact, at });
    db.close();
    const port = await freePort();
    const alias = join(dirname(dbPath), "current-main.js");
    symlinkSync(MAIN, alias);
    const child = spawn(process.execPath, [
      alias,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--db", dbPath,
      "--static-root", STATIC,
      "--closeout-key-id", trustedCloseoutKey.key_id,
      "--closeout-public-key-spki", trustedCloseoutKey.public_key_spki,
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
      const today = await request(`${origin}/api/v1/today`);
      expect(today.statusCode).toBe(200);
      expect(JSON.parse(await today.body.text()).latest_verified_closeout).toMatchObject({
        artifact_id: artifact.artifact_id, verified_completion_count: 1,
      });
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
