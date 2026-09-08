import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import { NativeEveningStore } from "../../src/evening-native-store.js";
import { generateNativeEveningEnvelope } from "../../src/evening-native-envelope.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { dailyLoopUsage } from "../../src/daily-loop-usage.js";
import { kstLocalDate } from "../../src/daily-loop-time.js";
import { canonicalize } from "../../src/canonical.js";
import { signer, trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import { forgetSecondPublicationSource, SECOND_SOURCE_TARGET } from "../fixtures/morning-publication.js";
import { initialized } from "../helpers.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { request } from "undici";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const f = await taskPublicationFixture(); cleanups.push(f.cleanup);
  const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
  await settleTaskExecution({ ...input, publication_id: publication.publication_id });
  const loop = new DailyLoopStore(f.db); const date = kstLocalDate(f.now);
  const runId = loop.prepare({ due: { kind: "due", local_date: date, phase: "evening", scheduled_at: f.now.toISOString() },
    created_at: f.now, deadline_at: new Date(f.now.getTime() + 60000), steps: [{ key: "evening_summary", sequence: 1 }] });
  const claim = loop.claim({ run_id: runId, owner_id: "native-evening-test", at: f.now, lease_ms: 30000 })!;
  const config = { repository_identities: [f.plan.publication.repository_identity], max_records: 10, max_bytes: 1048576 };
  const correlation = (f.db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string }).correlation_id;
  const artifact = generateNativeEveningEnvelope(f.db, { ...config, run_id: runId, correlation_id: correlation,
    local_date: date, observed_at: f.now }, signer(f.now.toISOString()));
  const budgets = { max_items: 1, max_work: 1, max_bytes: Buffer.byteLength(canonicalize(artifact)) };
  const projections = new MemoryProjectionAuthority(f.db);
  const bind = () => projections.bind({ kind: "control_payload", id: "execute", component_id: "execute" },
    [{ target_digest: SECOND_SOURCE_TARGET, source_identity_digest: `sha256:${"b".repeat(64)}` }], f.now);
  return { ...f, loop, runId, claim, config, artifact, budgets, date, projections, bind };
}

it("serves native completion on Today only with configured scope and current source validity", async () => {
  const f = await fixture(); f.bind();
  new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now)
    .settleWithinBudget({ claim: f.claim, artifact: f.artifact }, f.budgets);
  for (const mode of ["missing", "wrong", "configured"] as const) {
    const server = createDashboardServer({ db: f.db, staticRoot: "dist/dashboard", host: "127.0.0.1", port: 0,
      clock: () => f.now, trustedCloseoutKey,
      ...(mode === "missing" ? {} : { nativeCloseoutSource: { ...f.config, repository_identities: mode === "wrong" ? [] : f.config.repository_identities } }) });
    try {
      const before = f.db.db.prepare("SELECT total_changes() AS n").get();
      const response = await request(`http://127.0.0.1:${server.address.port}/api/v1/today`);
      const body = await response.body.json() as Record<string, unknown>;
      expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      if (mode === "wrong") expect(response.statusCode).toBeGreaterThanOrEqual(400);
      else {
        expect(response.statusCode).toBe(200);
        if (mode === "missing") expect(body.latest_verified_closeout).toBeNull();
        else expect(body.latest_verified_closeout).toMatchObject({ artifact_id: f.artifact.artifact_id,
          verified_completion_count: 1, source_readiness: "degraded" });
      }
      if (mode === "configured") {
        f.projections.quarantineUnresolved({ kind: "control_payload", id: "execute", component_id: "execute" }, f.now);
        const hidden = await request(`http://127.0.0.1:${server.address.port}/api/v1/today`);
        expect(hidden.statusCode).toBeGreaterThanOrEqual(400);
        expect(await hidden.body.text()).not.toContain(f.artifact.artifact_id);
      }
    } finally { server.close(); }
  }
});

it("publishes original native evidence atomically, reopens it, and preserves usage after source quarantine", async () => {
  const f = await fixture();
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  const input = { claim: f.claim, artifact: f.artifact };
  expect(() => store.settleWithinBudget(input, f.budgets)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(f.loop.steps(f.runId)[0]?.state).toBe("pending"); // Missing recorded provenance is not invented.
  f.bind();
  expect(store.settleWithinBudget(input, f.budgets)).toBe(true);
  expect(store.settleWithinBudget(input, f.budgets)).toBe(false);
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(store.read(f.runId)).toEqual(f.artifact);
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { NativeEveningStore } from './dist/src/evening-native-store.js';
    const db = new AuthorityDb(process.argv[1]);
    try { const store = new NativeEveningStore(db, JSON.parse(process.argv[2]), JSON.parse(process.argv[3]), () => new Date(process.argv[4]));
      process.stdout.write(store.read(process.argv[5]).source_digest); } finally { db.close(); }
  `, f.db.filename, JSON.stringify(trustedCloseoutKey), JSON.stringify(f.config), f.now.toISOString(), f.runId], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0); expect(child.stdout).toBe(f.artifact.source_digest);
  const cost = dailyLoopUsage(f.db, f.date, trustedCloseoutKey);
  f.projections.quarantineUnresolved({ kind: "control_payload", id: "execute", component_id: "execute" }, f.now);
  expect(() => store.read(f.runId)).toThrow();
  expect(dailyLoopUsage(f.db, f.date, trustedCloseoutKey)).toEqual(cost);
});

it("rolls back budget, interruption, stale fence, elapsed lease, and configured scope failures", async () => {
  const f = await fixture(); f.bind(); const input = { claim: f.claim, artifact: f.artifact };
  const snapshot = () => ({ run: f.db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(f.runId),
    checkpoints: f.db.db.prepare("SELECT * FROM daily_loop_checkpoints WHERE run_id=?").all(f.runId),
    publications: f.db.db.prepare("SELECT * FROM native_evening_publications").all(),
    step: f.loop.steps(f.runId), lineage: f.db.db.prepare("SELECT * FROM memory_projection_dependencies ORDER BY projection_kind,projection_id,target_digest").all() });
  const before = snapshot();
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  for (const dimension of ["items", "work", "bytes"] as const) {
    const key = `max_${dimension}` as const;
    expect(() => store.settleWithinBudget(input, { ...f.budgets, [key]: f.budgets[key] - 1 })).toThrow();
    expect(snapshot()).toEqual(before);
  }
  expect(() => new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now, () => { throw new Error("INTERRUPTED"); })
    .settleWithinBudget(input, f.budgets)).toThrow("INTERRUPTED");
  expect(snapshot()).toEqual(before);
  expect(() => store.settleWithinBudget({ ...input, claim: { ...f.claim, fence: f.claim.fence + 1 } }, f.budgets)).toThrow();
  expect(() => new NativeEveningStore(f.db, trustedCloseoutKey, { ...f.config, repository_identities: [] }, () => f.now)
    .settleWithinBudget(input, f.budgets)).toThrow();
  expect(() => new NativeEveningStore(f.db, { ...trustedCloseoutKey, key_id: "wrong-key" }, f.config, () => f.now)
    .settleWithinBudget(input, f.budgets)).toThrow();
  let clocks = 0;
  expect(() => new NativeEveningStore(f.db, trustedCloseoutKey, f.config,
    () => clocks++ === 0 ? f.now : new Date(f.claim.lease_expires_at)).settleWithinBudget(input, f.budgets)).toThrow();
  expect(snapshot()).toEqual(before);
  expect(store.settleWithinBudget(input, f.budgets)).toBe(true);
});

it("copies memory target dependencies and hides a published report after target suppression", async () => {
  const f = await fixture(); f.bind();
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  store.settleWithinBudget({ claim: f.claim, artifact: f.artifact }, f.budgets);
  const targets = f.db.db.prepare(`SELECT projection_kind FROM memory_projection_dependencies
    WHERE projection_kind IN ('daily_run','daily_step','evening_closeout') AND target_digest=? ORDER BY projection_kind`).all(SECOND_SOURCE_TARGET);
  expect(targets).toEqual([{ projection_kind: "daily_run" }, { projection_kind: "daily_step" }, { projection_kind: "evening_closeout" }]);
  const cost = dailyLoopUsage(f.db, f.date, trustedCloseoutKey);
  forgetSecondPublicationSource(f.db);
  expect(() => store.read(f.runId)).toThrow();
  expect(dailyLoopUsage(f.db, f.date, trustedCloseoutKey)).toEqual(cost);
});

it("rejects distinct source identities lost by the target-only lineage key", async () => {
  const f = await fixture(); f.bind();
  f.projections.bind({ kind: "observation", id: f.plan.run_id, component_id: f.plan.run_id },
    [{ target_digest: SECOND_SOURCE_TARGET, source_identity_digest: `sha256:${"c".repeat(64)}` }], f.now);
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  expect(() => store.settleWithinBudget({ claim: f.claim, artifact: f.artifact }, f.budgets)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(f.loop.steps(f.runId)[0]?.state).toBe("pending");
});

it("rejects unrelated preexisting report lineage without partial publication", async () => {
  const f = await fixture(); f.bind();
  f.projections.bind({ kind: "daily_run", id: f.runId, component_id: f.runId },
    [{ target_digest: `sha256:${"f".repeat(64)}` }], f.now);
  const before = f.db.db.prepare("SELECT * FROM memory_projection_dependencies ORDER BY projection_kind,projection_id,target_digest").all();
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  expect(() => store.settleWithinBudget({ claim: f.claim, artifact: f.artifact }, f.budgets)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(f.loop.steps(f.runId)[0]?.state).toBe("pending");
  expect(f.db.db.prepare("SELECT * FROM native_evening_publications").all()).toEqual([]);
  expect(f.db.db.prepare("SELECT * FROM memory_projection_dependencies ORDER BY projection_kind,projection_id,target_digest").all()).toEqual(before);
});

it("rejects replay and reads observed before the recorded completion time", async () => {
  const f = await fixture(); f.bind(); let clocks = 0;
  const input = { claim: f.claim, artifact: f.artifact };
  new NativeEveningStore(f.db, trustedCloseoutKey, f.config,
    () => clocks++ === 0 ? f.now : new Date(f.now.getTime() + 1)).settleWithinBudget(input, f.budgets);
  const oldClock = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(() => oldClock.settleWithinBudget(input, f.budgets)).toThrow();
  expect(() => oldClock.read(f.runId)).toThrow();
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("rejects a generic completed ledger that omitted the report's deletion dependencies", async () => {
  const f = await fixture(); f.bind();
  f.loop.completeStep({ claim: f.claim, step: f.loop.steps(f.runId)[0]!, detail: f.artifact, at: f.now });
  f.loop.complete(f.claim, f.now);
  const store = new NativeEveningStore(f.db, trustedCloseoutKey, f.config, () => f.now);
  expect(() => store.read(f.runId)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(() => store.settleWithinBudget({ claim: f.claim, artifact: f.artifact }, f.budgets)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
});

it.each([false, true])("requires native admission for empty reports (generic=%s)", async generic => {
  const db = await initialized(); cleanups.push(async () => db.close());
  const at = new Date("2026-08-30T12:00:00.000Z"); const date = kstLocalDate(at);
  const loop = new DailyLoopStore(db);
  const runId = loop.prepare({ due: { kind: "due", local_date: date, phase: "evening", scheduled_at: at.toISOString() },
    created_at: at, deadline_at: new Date(at.getTime() + 60000), steps: [{ key: "evening_summary", sequence: 1 }] });
  const claim = loop.claim({ run_id: runId, owner_id: "empty-native", at, lease_ms: 30000 })!;
  const config = { repository_identities: [], max_records: 10, max_bytes: 1048576 };
  const correlation = (db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string }).correlation_id;
  const artifact = generateNativeEveningEnvelope(db, { ...config, run_id: runId, correlation_id: correlation, local_date: date, observed_at: at }, signer(at.toISOString()));
  const store = new NativeEveningStore(db, trustedCloseoutKey, config, () => at);
  const budgets = { max_items: 1, max_work: 1, max_bytes: 10000 };
  if (generic) {
    loop.completeStep({ claim, step: loop.steps(runId)[0]!, detail: artifact, at }); loop.complete(claim, at);
    expect(() => store.read(runId)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => store.settleWithinBudget({ claim, artifact }, budgets)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  } else {
    expect(store.settleWithinBudget({ claim, artifact }, budgets)).toBe(true);
    expect(store.read(runId)).toEqual(artifact);
    expect(store.settleWithinBudget({ claim, artifact }, budgets)).toBe(false);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM native_evening_publications").get()).toEqual({ n: 1 });
  }
});
