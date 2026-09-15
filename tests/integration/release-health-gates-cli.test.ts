import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/cli-runtime.mjs";
import {
  DASHBOARD_HEALTH_ROUTE,
  DASHBOARD_RUNTIME_HOST,
  DASHBOARD_RUNTIME_PORT,
} from "../../src/dashboard-runtime-config.js";
import { RELEASE_GATE_NAMES } from "../../src/release-health-gates.js";
import { ensureCycleCursor } from "../../src/personal-os-cycle-channel.js";
import { passiveSecondBrainReadinessProbe } from "../../src/second-brain-readiness.js";
import { runtimeCapabilityProbe } from "../../src/doctor.js";
import { cleanupFixtures, fixture } from "../fixtures/second-brain-transport-harness.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const run = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupFixtures();
  delete process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  delete process.env["JARVIS_SECOND_BRAIN_CONFIG"];
  process.exitCode = undefined;
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "release-gates-"));
  roots.push(root);
  return root;
}

async function healthServer(body: unknown, status = 200): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, DASHBOARD_RUNTIME_HOST, () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("health fixture address unavailable");
  return `http://${DASHBOARD_RUNTIME_HOST}:${address.port}${DASHBOARD_HEALTH_ROUTE}`;
}

/** An isolated database whose only defect is a real referential violation. */
function foreignKeyViolatingDatabase(): string {
  const path = join(scratch(), "violating.sqlite");
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY);"
      + "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));"
      + "INSERT INTO child(id,parent_id) VALUES (1, 404);");
  } finally {
    db.close();
  }
  return path;
}

async function migrated(): Promise<string> {
  const db = await migratedTestDatabase(tempDb());
  const path = db.filename;
  ensureCycleCursor(db.db);
  db.close();
  return path;
}

const probes = {
  capabilityProbe: runtimeCapabilityProbe(async () => ({ stdout: "", exitCode: 127 })),
  secondBrainProbe: passiveSecondBrainReadinessProbe(),
};

describe("release health gate CLIs", () => {
  it("pins the dashboard health route the deployed unit binds", () => {
    const schema = JSON.parse(readFileSync("config/dashboard-runtime.schema.json", "utf8"));
    expect(schema.properties.host.const).toBe(DASHBOARD_RUNTIME_HOST);
    expect(schema.properties.port.const).toBe(DASHBOARD_RUNTIME_PORT);
    const unit = readFileSync("deploy/jm-jarvis-dashboard.service", "utf8");
    expect(unit).toContain(`--host ${DASHBOARD_RUNTIME_HOST}`);
    expect(unit).toContain(`--port ${DASHBOARD_RUNTIME_PORT}`);
    expect(readFileSync("src/dashboard/api-routes.ts", "utf8")).toContain(`"${DASHBOARD_HEALTH_ROUTE}"`);
  });

  it("passes foreign-key-check on a migrated database and fails on a real violation", async () => {
    await expect(execute(["db", "foreign-key-check", "--db", await migrated()]))
      .resolves.toMatchObject({ ok: true, command: "db.foreign-key-check", gate: { name: "foreign-key-check", ok: true } });
    const failed = await execute(["db", "foreign-key-check", "--db", foreignKeyViolatingDatabase()]);
    expect(failed).toMatchObject({ ok: false, exit_code: 1,
      gate: { name: "foreign-key-check", ok: false, code: "DATABASE_FOREIGN_KEY_VIOLATION" } });
  });

  it("exits non-zero from the real CLI when a gate fails", async () => {
    const path = foreignKeyViolatingDatabase();
    await expect(run(process.execPath, ["dist/src/cli.js", "db", "foreign-key-check", "--db", path]))
      .rejects.toMatchObject({ code: 1 });
    const ok = await run(process.execPath, ["dist/src/cli.js", "db", "foreign-key-check", "--db", await migrated()]);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, gate: { ok: true } });
  });

  it("reads the dashboard health route with a bounded timeout and fails closed", async () => {
    const url = await healthServer({ schema_version: 1, status: "ok", authority: "ready" });
    await expect(execute(["release", "dashboard-health", "--dashboard-url", url]))
      .resolves.toMatchObject({ ok: true, gate: { name: "dashboard-health", ok: true } });
    const degraded = await healthServer({ schema_version: 1, status: "degraded", authority: "ready" });
    expect(await execute(["release", "dashboard-health", "--dashboard-url", degraded]))
      .toMatchObject({ ok: false, exit_code: 1, gate: { code: "RELEASE_GATE_DASHBOARD_UNHEALTHY" } });
    const unreachable = await execute(["release", "dashboard-health",
      "--dashboard-url", "http://127.0.0.1:1/api/v1/health"]);
    expect(unreachable).toMatchObject({ ok: false, gate: { name: "dashboard-health", ok: false } });
  });

  it("completes a real handshake through the Second Brain transport contract", async () => {
    const provider = fixture();
    process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = provider.launcher;
    process.env["JARVIS_SECOND_BRAIN_CONFIG"] = provider.config;
    expect(await execute(["release", "mcp-handshake"])).toMatchObject({
      ok: true,
      command: "release.mcp-handshake",
      gate: { name: "mcp-handshake", ok: true,
        actual: { protocol_version: "2025-11-25", contract_profile: "task32-schema4" } },
    });
    const mismatched = fixture({ protocolVersion: "2026-07-28" });
    process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = mismatched.launcher;
    process.env["JARVIS_SECOND_BRAIN_CONFIG"] = mismatched.config;
    expect(await execute(["release", "mcp-handshake"]))
      .toMatchObject({ ok: false, exit_code: 1, gate: { code: "SECOND_BRAIN_VERSION_MISMATCH" } });
  }, 30_000);

  it("reports the persisted cycle cursor and its daily_loop_runs consistency", async () => {
    const path = await migrated();
    expect(await execute(["release", "scheduler-cursor", "--db", path])).toMatchObject({
      ok: true,
      gate: { name: "scheduler-cursor", ok: true,
        actual: { last_completed: 0, applied_count: 0, next_cycle_id: 1, completed_daily_loop_runs: 0 } },
    });
    const absent = await migratedTestDatabase(tempDb());
    const absentPath = absent.filename;
    absent.close();
    expect(await execute(["release", "scheduler-cursor", "--db", absentPath]))
      .toMatchObject({ ok: false, exit_code: 1, gate: { code: "RELEASE_GATE_SCHEDULER_CURSOR_ABSENT" } });
    const drifted = new Database(path);
    try {
      drifted.prepare("UPDATE personal_os_cycle_cursor SET last_completed=5, applied_count=2 WHERE k=1").run();
    } finally {
      drifted.close();
    }
    expect(await execute(["release", "scheduler-cursor", "--db", path]))
      .toMatchObject({ ok: false, gate: { code: "RELEASE_GATE_SCHEDULER_CURSOR_INCONSISTENT" } });
  });

  it("runs all nine documented gates and refuses the aggregate when any one fails", async () => {
    const path = await migrated();
    const provider = fixture();
    process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = provider.launcher;
    process.env["JARVIS_SECOND_BRAIN_CONFIG"] = provider.config;
    const url = await healthServer({ schema_version: 1, status: "ok", authority: "ready" });
    const passing = await execute(["release", "gates", "--db", path, "--dashboard-url", url], probes);
    expect(passing["command"]).toBe("release.gates");
    const report = passing["report"] as { ok: boolean; gates: Array<{ name: string; ok: boolean }>; failed: string[] };
    expect(report.gates.map(item => item.name)).toEqual([...RELEASE_GATE_NAMES]);
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(passing["exit_code"]).toBeUndefined();

    const broken = await execute(["release", "gates", "--db", path,
      "--dashboard-url", "http://127.0.0.1:1/api/v1/health"], probes);
    expect(broken).toMatchObject({ ok: false, exit_code: 1 });
    expect((broken["report"] as { failed: string[] }).failed).toContain("dashboard-health");
  }, 60_000);

  it("reports pending migrations instead of requiring them", async () => {
    const path = join(scratch(), "old.sqlite");
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    } finally {
      db.close();
    }
    const gates = await execute(["release", "gates", "--db", path], probes);
    const report = gates["report"] as { gates: Array<{ name: string; ok: boolean; code?: string;
      actual: Record<string, unknown> }> };
    const vector = report.gates.find(item => item.name === "migration-vector");
    expect(vector).toMatchObject({ ok: false, code: "MIGRATIONS_PENDING" });
    expect((vector?.actual["pending_migrations"] as string[]).length).toBeGreaterThan(40);
  }, 60_000);

  it("refuses unknown options and a missing database instead of creating one", async () => {
    await expect(execute(["release", "gates"])).rejects.toMatchObject({ code: "RELEASE_GATE_INPUT_INVALID" });
    await expect(execute(["release", "gates", "--db", join(scratch(), "absent.sqlite")]))
      .rejects.toMatchObject({ code: "RELEASE_GATE_DATABASE_UNAVAILABLE" });
    await expect(execute(["db", "foreign-key-check", "--db", await migrated(), "--once"]))
      .rejects.toMatchObject({ code: "RELEASE_GATE_INPUT_INVALID" });
  });
});
