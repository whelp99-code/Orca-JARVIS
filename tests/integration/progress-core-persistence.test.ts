import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorityDb, serializeProgressReport } from "../../src/index.js";
import type { ProgressAssessment, ProgressBatch, ProgressTransitionEvidence } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const assessment = (overrides: Record<string, unknown> = {}): ProgressAssessment => ({ provider: "codex", terminal_id: "terminal", incarnation_id: "one", cursor: "1", observation_identity: hash("1"), state: "running", ...overrides } as ProgressAssessment);
const batch = (overrides: Record<string, unknown> = {}): ProgressBatch => ({ version: 1, worktree: "active", observed_at: "2026-08-09T06:00:00.000Z", assessments: [assessment()], ...overrides } as ProgressBatch);
let migratedTemplate = "";
async function database(filename = tempDb()): Promise<AuthorityDb> { copyFileSync(migratedTemplate, filename); const db = new AuthorityDb(filename); await db.assertMigrationsReady(); return db; }
const count = (db: AuthorityDb, table: string) => Number((db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
const deliver = (db: AuthorityDb, report: { report_id: string }, at = "2026-08-09T06:01:00.000Z") => db.markProgressDelivered(report.report_id, at);
const expectCode = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ code }));
const exit = (child: ChildProcessWithoutNullStreams, timeout = 8_000) => new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child timeout")); }, timeout); child.once("exit", code => { clearTimeout(timer); resolve(code); }); });
const line = (child: ChildProcessWithoutNullStreams, expected: string, timeout = 8_000) => new Promise<string>((resolve, reject) => { let output = ""; let errorOutput = ""; child.stderr.on("data", data => { errorOutput += data.toString("utf8"); }); const timer = setTimeout(() => reject(new Error(`missing ${expected}: ${errorOutput}`)), timeout); child.stdout.on("data", data => { output += data.toString("utf8"); if (output.includes(expected)) { clearTimeout(timer); resolve(output); } }); });
const fixture = (file: string, filename: string, input: ProgressBatch) => spawn(process.execPath, [join(process.cwd(), "tests/fixtures", file), filename, JSON.stringify(input)], { env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/Volumes/DevSpace/tmp", PROGRESS_MODULE_URL: pathToFileURL(join(process.cwd(), "dist/src/index.js")).href }, stdio: ["pipe", "pipe", "pipe"] });
const terminate = (child: ChildProcessWithoutNullStreams | undefined) => { if (child?.exitCode === null) child.kill("SIGKILL"); };

describe("progress report persistence", () => {
  beforeAll(async () => {
    const distIndex = join(process.cwd(), "dist/src/index.js");
    const distMigrations = join(process.cwd(), "dist/migrations");
    if (!existsSync(distMigrations)) {
      const copied = spawnSync(process.execPath, ["scripts/copy-migrations.mjs"], { cwd: process.cwd(), encoding: "utf8" });
      if (copied.status !== 0) throw new Error(copied.stderr || copied.stdout || "copy-migrations failed");
    }
    assert.ok(existsSync(distIndex), `expected build artifact at ${distIndex}; npm pretest must run npm run build`);
    migratedTemplate = tempDb();
    const template = new AuthorityDb(migratedTemplate);
    await template.migrate();
    template.db.pragma("wal_checkpoint(TRUNCATE)");
    template.close();
  });
  afterAll(() => { if (migratedTemplate) rmSync(dirname(migratedTemplate), { recursive: true, force: true }); });
  it("persists timestamps, handles replay/output-before-mark, and validates delivery marks", async () => {
    const filename = tempDb(); const db = await database(filename); const first = db.stageProgressBatch(batch()).report!;
    expect(first).toMatchObject({ worktree: "active", created_at: "2026-08-09T06:00:00.000Z" }); expect(db.db.prepare("SELECT observed_at,updated_at FROM progress_projection").get()).toEqual({ observed_at: "2026-08-09T06:00:00.000Z", updated_at: "2026-08-09T06:00:00.000Z" });
    const emitted = first.payload_json; db.close(); const reopened = new AuthorityDb(filename); expect(reopened.pendingProgressReport()!.payload_json).toBe(emitted); deliver(reopened, first); deliver(reopened, first); expect(count(reopened, "progress_delivery_receipts")).toBe(1); expect(reopened.db.prepare("SELECT delivered_at FROM progress_delivery_receipts WHERE report_id=?").get(first.report_id)).toEqual({ delivered_at: "2026-08-09T06:01:00.000Z" });
    expectCode(() => reopened.markProgressDelivered(first.report_id, "2026-08-09T06:02:00.000Z"), "PROGRESS_DELIVERY_MARK_FAILED"); expect(reopened.db.prepare("SELECT delivered_at FROM progress_delivery_receipts WHERE report_id=?").get(first.report_id)).toEqual({ delivered_at: "2026-08-09T06:01:00.000Z" }); expect(reopened.stageProgressBatch(batch())).toEqual({ report: null });
    expectCode(() => reopened.markProgressDelivered(first.report_id, "bad"), "PROGRESS_DELIVERY_MARK_FAILED"); expectCode(() => reopened.markProgressDelivered(`progress_${"f".repeat(64)}`, "2026-08-09T06:02:00.000Z"), "PROGRESS_DELIVERY_MARK_FAILED"); reopened.close();
  });
  it("advances same-state projections without a report, leaves missing terminals, and resets new incarnations", async () => {
    const db = await database(); const first = db.stageProgressBatch(batch()).report!; deliver(db, first);
    expect(db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:02:00.000Z", assessments: [assessment({ observation_identity: hash("2") })] }))).toEqual({ report: null }); expect(count(db, "progress_report_outbox")).toBe(1);
    expect(db.db.prepare("SELECT observed_at FROM progress_projection WHERE terminal_handle='terminal'").get()).toEqual({ observed_at: "2026-08-09T06:02:00.000Z" });
    const second = db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:03:00.000Z", assessments: [assessment({ terminal_id: "other", observation_identity: hash("3"), state: "stopped" })] })).report!; expect(second.payload_json).toContain("\"terminal_id\":\"other\""); expect(db.db.prepare("SELECT state FROM progress_projection WHERE terminal_handle='terminal'").get()).toEqual({ state: "running" }); deliver(db, second, "2026-08-09T06:04:00.000Z");
    const newIncarnation = db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:05:00.000Z", assessments: [assessment({ provider: "claude", incarnation_id: "two", observation_identity: hash("4"), state: "needs_input" })] })).report!; expect(newIncarnation.payload_json).toContain("\"from\":null"); deliver(db, newIncarnation, "2026-08-09T06:06:00.000Z"); db.close();
  });
  it("enforces deterministic precedence, sorting, collision, and immutable records", async () => {
    const db = await database(); const sorted = db.stageProgressBatch(batch({ assessments: [assessment({ provider: "codex", terminal_id: "z", observation_identity: hash("5") }), assessment({ provider: "claude", terminal_id: "a", observation_identity: hash("6"), state: "stopped" })] })).report!;
    expect(JSON.parse(sorted.payload_json).transitions.map((item: { provider: string; terminal_id: string }) => `${item.provider}:${item.terminal_id}`)).toEqual(["claude:a", "codex:z"]); deliver(db, sorted);
    expectCode(() => db.stageProgressBatch(batch({ assessments: [assessment({ terminal_id: "z", observation_identity: hash("7") })] })), "PROGRESS_STALE_ASSESSMENT");
    expectCode(() => db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:01:00.000Z", assessments: [assessment({ terminal_id: "z", provider: "claude", observation_identity: hash("8") })] })), "PROGRESS_BINDING_CONFLICT");
    expectCode(() => db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:01:00.000Z", assessments: [assessment({ terminal_id: "z", observation_identity: hash("5"), state: "stopped" })] })), "PROGRESS_OBSERVATION_CONFLICT");
    const transition: ProgressTransitionEvidence = { provider: "codex", terminal_id: "collision", incarnation_id: "one", cursor: "1", from: null, to: "running", observation_identity: hash("9") }; const collision = serializeProgressReport("active", "2026-08-09T06:02:00.000Z", [transition]);
    db.db.prepare("INSERT INTO progress_report_outbox(report_id,worktree_selector,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?)").run(collision.report_id, "active", collision.payload_json, collision.payload_digest, "2026-08-09T06:02:00.000Z"); db.db.prepare("INSERT INTO progress_delivery_receipts(report_id,delivered_at) VALUES(?,?)").run(collision.report_id, "2026-08-09T06:02:00.000Z");
    expectCode(() => db.stageProgressBatch(batch({ observed_at: "2026-08-09T06:02:00.000Z", assessments: [assessment({ terminal_id: "collision", observation_identity: hash("9") })] })), "PROGRESS_REPORT_ID_CONFLICT");
    for (const [table, column] of [["progress_observations", "provider"], ["progress_report_outbox", "report_id"], ["progress_delivery_receipts", "delivered_at"]]) { expect(() => db.db.prepare(`UPDATE ${table} SET ${column}=${column}`).run()).toThrow(); expect(() => db.db.prepare(`DELETE FROM ${table}`).run()).toThrow(); } db.close();
  });
  it("rolls back all pre-commit faults and leaves all post-commit effects observable", async () => {
    for (const point of ["before_observation_insert", "after_observation_insert", "after_projection_upsert", "after_outbox_insert_before_commit"] as const) { const db = await database(); (db as unknown as { progressFaultPoint: string }).progressFaultPoint = point; expectCode(() => db.stageProgressBatch(batch()), "SIMULATED_PROGRESS_CRASH"); expect([count(db, "progress_observations"), count(db, "progress_projection"), count(db, "progress_report_outbox")]).toEqual([0, 0, 0]); db.close(); }
    const staged = await database(); (staged as unknown as { progressFaultPoint: string }).progressFaultPoint = "after_stage_commit"; expectCode(() => staged.stageProgressBatch(batch()), "SIMULATED_PROGRESS_CRASH"); expect([count(staged, "progress_observations"), count(staged, "progress_projection"), count(staged, "progress_report_outbox")]).toEqual([1, 1, 1]); staged.close();
    for (const point of ["before_receipt_insert", "after_receipt_insert_before_commit"] as const) { const db = await database(); const report = db.stageProgressBatch(batch()).report!; (db as unknown as { progressFaultPoint: string }).progressFaultPoint = point; expectCode(() => deliver(db, report), "SIMULATED_PROGRESS_CRASH"); expect(count(db, "progress_delivery_receipts")).toBe(0); db.close(); }
    const delivered = await database(); const report = delivered.stageProgressBatch(batch()).report!; (delivered as unknown as { progressFaultPoint: string }).progressFaultPoint = "after_receipt_commit"; expectCode(() => deliver(delivered, report), "SIMULATED_PROGRESS_CRASH"); expect(count(delivered, "progress_delivery_receipts")).toBe(1); delivered.close();
  });
  it("runs the two-process winner/loser release and busy-timeout contracts through the fixtures", async () => {
    const modulePath = join(process.cwd(), "dist/src/index.js");
    assert.ok(existsSync(modulePath), `expected build artifact at ${modulePath}; npm pretest must run npm run build`);
    const input = batch({ worktree: "fixture", assessments: [assessment({ terminal_id: "fixture", observation_identity: hash("a") })] });
    let winner: ChildProcessWithoutNullStreams | undefined; let loser: ChildProcessWithoutNullStreams | undefined; let held: ChildProcessWithoutNullStreams | undefined; let timed: ChildProcessWithoutNullStreams | undefined;
    try {
      const releaseFile = tempDb(); const releaseSeed = await database(releaseFile); releaseSeed.close(); winner = fixture("progress-lock-holder.mjs", releaseFile, input); await line(winner, "READY\n"); loser = fixture("progress-stage-child.mjs", releaseFile, input); let loserOutput = ""; loser.stdout.on("data", data => { loserOutput += data.toString("utf8"); }); await line(loser, "ATTEMPT\n"); setTimeout(() => winner?.stdin.end("RELEASE\n"), 100); const [winnerExit, loserExit] = await Promise.all([exit(winner), exit(loser)]); expect([winnerExit, loserExit]).toEqual([0, 2]); expect(loserOutput).toContain("PROGRESS_PENDING_REPORT"); const releaseDb = new AuthorityDb(releaseFile); expect(count(releaseDb, "progress_observations")).toBe(1); expect(count(releaseDb, "progress_projection")).toBe(1); expect(count(releaseDb, "progress_report_outbox")).toBe(1); releaseDb.close();
      const timeoutFile = tempDb(); const timeoutSeed = await database(timeoutFile); timeoutSeed.close(); held = fixture("progress-lock-holder.mjs", timeoutFile, input); await line(held, "READY\n"); timed = fixture("progress-stage-child.mjs", timeoutFile, input); let timeoutOutput = ""; timed.stdout.on("data", data => { timeoutOutput += data.toString("utf8"); }); await line(timed, "ATTEMPT\n"); const timedExit = await exit(timed, 6_500); expect(timedExit).toBe(2); expect(timeoutOutput).toContain("PROGRESS_STORAGE_FAILED"); held.stdin.end("RELEASE\n"); expect(await exit(held)).toBe(0); const timeoutDb = new AuthorityDb(timeoutFile); expect([count(timeoutDb, "progress_observations"), count(timeoutDb, "progress_projection"), count(timeoutDb, "progress_report_outbox")]).toEqual([1, 1, 1]); timeoutDb.close();
    } finally { terminate(winner); terminate(loser); terminate(held); terminate(timed); }
  }, 20_000);
});
