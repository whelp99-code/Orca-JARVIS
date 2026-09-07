import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, JarvisError } from "../../src/db.js";
import { execute } from "../../src/cli.js";
import { LiveSupervisor, type LiveBinding } from "../../src/live-supervisor.js";
import { observePersistedBinding } from "../../src/persisted-orca-observer.js";
import { readObservationHealth } from "../../src/runtime-health.js";
import { GjcRuntimeService } from "../../src/service.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import type { OrcaRunner } from "../../src/orca.js";
import { tempDb } from "../helpers.js";

const databases: AuthorityDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const base = Date.parse("2026-09-08T09:00:00.000Z");
async function setup() {
  const path = tempDb(); const db = new AuthorityDb(path); databases.push(db); await db.migrate();
  db.configureGjc(process.cwd(), "s", true);
  const binding = new LiveSupervisor(db).register({ worktree: process.cwd(), provider: "codex", terminal_id: "term",
    session_id: "session", incarnation_id: "inc", pty_id: "pty", worktree_id: "wt" });
  return { path, db, binding };
}
function healthy(binding: LiveBinding): OrcaRunner {
  return async args => JSON.stringify({ ok: true, result: args[1] === "list" ? { terminals: [{
    handle: "term", incarnationId: "inc", ptyId: "pty", worktreeId: "wt", worktreePath: binding.canonical_path,
    title: null, preview: null, connected: true, writable: true, lastOutputAt: null,
  }] } : { terminal: { handle: "term", status: "running", tail: [], returnedLineCount: 0, truncated: false,
    limited: false, nextCursor: "cursor", oldestCursor: null, latestCursor: "cursor" } } });
}
function reply(body: unknown) {
  return { stdout: [
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } },
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", exitCode: 0 };
}
function coordinator(log: string[]) {
  return async (run: { stdin: string }) => {
    const name = JSON.parse(run.stdin.trim().split("\n")[2]!).params.name; log.push(name);
    return name === "gjc_coordinator_read_turn" ? reply({ ok: true, turn: { status: "completed", session_id: "s", turn_id: "t" } })
      : reply({ questions: [] });
  };
}
const runtime = (db: AuthorityDb) => db.db.prepare("SELECT * FROM gjc_runtime_status WHERE id=1").get() as Record<string, unknown>;

describe("service observation health integration", () => {
  it("writes verified coordinator recovery inside the runtime fence transaction", async () => {
    const { db } = await setup(); const calls: string[] = []; const clock = () => new Date(base);
    db.db.function("health_transaction_open", () => Number(db.db.inTransaction));
    db.db.exec(`CREATE TEMP TRIGGER require_health_transaction BEFORE UPDATE OF last_coordinator_success_at ON gjc_runtime_status
      WHEN health_transaction_open()=0 BEGIN SELECT RAISE(ABORT,'health update outside fence transaction'); END`);
    db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "atomic-health");
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(coordinator(calls)), "atomic-health", undefined, clock);
    try { await expect(service.once()).resolves.toMatchObject({ state: "completed" }); }
    finally { service.close(); }
    expect(runtime(db)).toMatchObject({ last_error_code: null, last_coordinator_success_at: clock().toISOString() });
  });
  it("preserves coordinator errors through idle observation and preserves observation errors through coordinator recovery", async () => {
    const { path, db, binding } = await setup(); let now = base; const clock = () => new Date(now); const calls: string[] = [];
    const args = ["service", "once", "--db", path]; let reads = 0;
    const read: OrcaRunner = async values => { reads++; return healthy(binding)(values); };
    db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "fail-first");
    await expect(execute(args, { clock, orcaRunner: read, gjcRunner: async () => { throw new Error("fixture"); }, liveReportOutput: () => {} }))
      .resolves.toMatchObject({ state: "uncertain" });
    const failure = runtime(db); expect(failure.last_error_code).not.toBeNull();
    expect(failure.last_coordinator_attempt_at).toBe(clock().toISOString()); expect(failure.last_coordinator_success_at).toBeNull();
    now += 1000;
    await execute(args, { clock, orcaRunner: read, gjcRunner: coordinator(calls), liveReportOutput: () => {} });
    expect(runtime(db).last_error_code).toBe(failure.last_error_code); expect(calls).toEqual([]);
    const successfulObservation = readObservationHealth(db, clock()).bindings[0]!.last_success_at;
    now += 1000; db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "recover");
    await expect(execute(args, { clock, orcaRunner: async () => { reads++; throw new JarvisError("ORCA_CLI_TIMEOUT"); },
      gjcRunner: coordinator(calls), liveReportOutput: () => {} })).resolves.toMatchObject({ state: "completed" });
    expect(runtime(db)).toMatchObject({ last_error_code: null, last_coordinator_success_at: clock().toISOString() });
    const outage = readObservationHealth(db, clock()).bindings[0]!;
    expect(outage).toMatchObject({ state: "unavailable", last_success_at: successfulObservation, error_code: "ORCA_CLI_TIMEOUT" });
    const readCount = reads; now += 1000;
    await execute(args, { clock, orcaRunner: read, gjcRunner: coordinator(calls), liveReportOutput: () => {} });
    expect(reads).toBe(readCount);
    const changes = db.db.pragma("data_version", { simple: true });
    await expect(execute(["service", "status", "--db", path], { clock })).resolves.toMatchObject({
      observation_health: { unavailable: 1 }, runtime: { last_error_code: null },
    });
    expect(db.db.pragma("data_version", { simple: true })).toEqual(changes);
    expect(readObservationHealth(db, clock()).bindings[0]).toEqual(outage);
  });

  it("never acknowledges a failed report output or calls the coordinator before it succeeds", async () => {
    const { path, db, binding } = await setup(); const calls: string[] = []; const clock = () => new Date(base);
    const intent = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "report");
    await expect(execute(["service", "once", "--db", path], { clock, orcaRunner: healthy(binding), gjcRunner: coordinator(calls),
      liveReportOutput: () => { throw new Error("fixture output failed"); } })).rejects.toThrow("fixture output failed");
    expect(calls).toEqual([]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_report_receipts").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(intent)).toEqual({ state: "pending" });
    await expect(execute(["service", "once", "--db", path], { clock, orcaRunner: async () => { throw new Error("must recover report first"); },
      gjcRunner: coordinator(calls), liveReportOutput: () => {} })).resolves.toMatchObject({ state: "completed" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_report_receipts").get()).toEqual({ n: 1 });
  });

  it("does not let recovered reports bypass a persisted fatal observation", async () => {
    const { path, db, binding } = await setup(); const calls: string[] = []; const clock = () => new Date(base);
    await execute(["supervisor", "once", "--db", path], { clock, orcaRunner: healthy(binding) });
    const current = new LiveSupervisor(db).list()[0]!;
    await expect(observePersistedBinding(db, current, async () => { throw new JarvisError("ORCA_PERMISSION_DENIED"); }, clock))
      .rejects.toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
    db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "fatal");
    await expect(execute(["service", "once", "--db", path], { clock, orcaRunner: healthy(binding),
      gjcRunner: coordinator(calls), liveReportOutput: () => {} })).rejects.toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
    expect(calls).toEqual([]);
    await expect(execute(["service", "once", "--db", path], { clock, orcaRunner: healthy(binding),
      gjcRunner: coordinator(calls), liveReportOutput: () => {} })).resolves.toMatchObject({ state: "completed" });
  });

  it("fences coordinator calls and health success after runtime lease loss during observation", async () => {
    const { path, db, binding } = await setup(); const calls: string[] = []; const clock = () => new Date(base); let fenced = false;
    db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "fenced");
    await expect(execute(["service", "once", "--db", path], { clock, orcaRunner: async args => {
      if (!fenced) { fenced = true; db.db.prepare("UPDATE gjc_runtime_leases SET fence=fence+1 WHERE id=1").run(); }
      return healthy(binding)(args);
    }, gjcRunner: coordinator(calls), liveReportOutput: () => {} })).rejects.toMatchObject({ code: "GJC_STALE_LEASE" });
    expect(calls).toEqual([]);
    expect(runtime(db)).toMatchObject({ last_coordinator_attempt_at: null, last_coordinator_success_at: null });
  });
});
