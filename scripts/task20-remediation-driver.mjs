import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { error as errorLog, log } from "node:console";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import process from "node:process";
import {
  AuthorityDb, DailyControlLoop, DailyLoopStore, canonicalize,
  classifyDailyLoopInstant, evaluateRefreshContext, kstInstant,
} from "orca-jarvis-shadow";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let assertions = 0;
let identityConflicts = 0;
let deferredAdmissions = 0;
let uncertainRuns = 0;
let forgedRows = 0;
let staleWriteSuccesses = 0;
let staleWriteRejections = 0;
let chainGaps = 0;
let chainBranches = 0;
let digestMismatches = 0;
let outOfScopeDeltas = 0;
let integrityFailures = 0;
let appendedRows = 0;
let stateDeltas = 0;
let forgedDigestMismatches = 0;
const roots = [];
const databases = [];
const hash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const check = (value, id) => { strictEqual(Boolean(value), true, id); assertions++; };
const equal = (actual, expected, id) => { deepStrictEqual(actual, expected, id); assertions++; };
const rejects = (operation, code, id) => {
  try { operation(); } catch (failure) { check(failure instanceof Error && (failure.message.includes(code) || failure.code === code), id); return failure; }
  throw new Error(`missing rejection ${id}`);
};
const rejectsAsync = async (operation, code, id) => {
  try { await operation(); } catch (failure) { check(failure instanceof Error && (failure.message.includes(code) || failure.code === code), id); return; }
  throw new Error(`missing rejection ${id}`);
};
const migrationFixture = include035 => { const root = mkdtempSync(join(tmpdir(), "task20-remediation-migrations-")); roots.push(root); const migrations = join(root, "migrations"); cpSync(join(packageRoot, "dist", "migrations"), migrations, { recursive: true }); if (!include035) rmSync(join(migrations, "035_daily_loop_durable_guards.sql")); return { root, migrations, path: join(root, "authority.sqlite") }; };
const open = async () => {
  const root = mkdtempSync(join(tmpdir(), "task20-remediation-driver-")); roots.push(root);
  const db = new AuthorityDb(join(root, "authority.sqlite")); databases.push(db); await db.migrate(); return db;
};
const options = (clock, overrides = {}) => ({
  time_zone: "Asia/Seoul", owner_id: "linux:stable", lease_ms: 60_000, deadline_ms: 600_000,
  recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock,
  event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides,
});
const event = (at, overrides = {}) => ({ kind: "event", event_id: "driver", occurred_at: at, critical: false, items: 1, work: 1, bytes: 1, ...overrides });
const counts = db => new Map(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]));
const dailyCounts = db => db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) AS runs,(SELECT count(*) FROM daily_loop_steps) AS steps,(SELECT count(*) FROM daily_loop_checkpoints) AS checkpoints").get();
const workerRace = async (path, runId, at) => { const workers = ["driver:a", "driver:b"].map(owner => new Worker(new URL("./task20-race-worker.mjs", import.meta.url), { workerData: { path, runId, at, owner, leaseMs: 60_000 } })); try { await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once("message", message => { if (message.kind === "ready") resolve(); }); worker.once("error", reject); }))); const results = workers.map(worker => new Promise((resolve, reject) => { worker.once("message", message => { if (message.kind === "result") resolve(message); }); worker.once("error", reject); })); for (const worker of workers) worker.postMessage({ kind: "go" }); return await Promise.all(results); } finally { await Promise.all(workers.map(worker => worker.terminate())); } };

async function behaviorMatrix() {
  const scheduledCases = [
    ["2026-08-30T22:14:59.999Z", "not_due"], ["2026-08-30T22:15:00.000Z", "due"], ["2026-08-30T22:15:00.001Z", "not_due"],
    ["2026-08-31T12:29:59.999Z", "not_due"], ["2026-08-31T12:30:00.000Z", "due"], ["2026-08-31T12:30:00.001Z", "not_due"],
  ];
  for (const [at, expected] of scheduledCases) equal(classifyDailyLoopInstant(new Date(at), { kind: "scheduled" }).kind, expected, `schedule:${at}`);
  const quietCases = [
    ["2026-08-30T21:59:59.999Z", "deferred"], ["2026-08-30T22:00:00.000Z", "due"], ["2026-08-30T22:00:00.001Z", "due"],
    ["2026-08-31T12:59:59.999Z", "due"], ["2026-08-31T13:00:00.000Z", "deferred"], ["2026-08-31T13:00:00.001Z", "deferred"],
  ];
  for (const [at, expected] of quietCases) equal(classifyDailyLoopInstant(new Date(at), event(at)).kind, expected, `quiet:${at}`);
  equal(classifyDailyLoopInstant(new Date("2026-08-31T14:00:00.000Z"), event("2026-08-31T14:00:00.000Z")).kind, "deferred", "quiet:ordinary");
  equal(classifyDailyLoopInstant(new Date("2026-08-31T14:00:00.000Z"), { ...event("2026-08-31T14:00:00.000Z"), critical: true, critical_reason: "urgent" }).bypass_reason, "critical_quiet_hours_bypass", "quiet:critical");
  for (const date of ["0000-01-01", "2026-00-01", "2026-13-01", "2026-01-00", "2026-02-29", "2026-02-30"]) rejects(() => kstInstant(date, 7, 15), "DAILY_LOOP_DATE_INVALID", `date:${date}`);

  const boundaryDb = await open();
  const base = options(() => new Date("2026-08-30T22:15:00.000Z"));
  const hostileValues = [null, [], Object.assign(Object.create({ x: true }), base), { ...base, [Symbol("x")]: true }];
  for (const [index, hostile] of hostileValues.entries()) rejects(() => Reflect.construct(DailyControlLoop, [new DailyLoopStore(boundaryDb), hostile]), "DAILY_LOOP_CONFIG_INVALID", `config:${index}`);
  let getterCalls = 0;
  rejects(() => Reflect.construct(DailyControlLoop, [new DailyLoopStore(boundaryDb), { ...base, budgets: Object.defineProperty({}, "max_items", { enumerable: true, get: () => { getterCalls++; throw new Error("getter"); } }) }]), "DAILY_LOOP_CONFIG_INVALID", "config:getter");
  equal(getterCalls, 0, "config:getter-not-called");
  const boundaryLoop = new DailyControlLoop(new DailyLoopStore(boundaryDb), base);
  for (const [index, hostile] of [null, [], Object.assign(Object.create({ x: true }), event("2026-08-31T03:00:00.000Z")), { ...event("2026-08-31T03:00:00.000Z"), [Symbol("x")]: true }].entries()) rejects(() => boundaryLoop.prepare(hostile), "DAILY_LOOP_EVENT_INVALID", `event:${index}`);
  equal(evaluateRefreshContext({ schema_version: 2 }, new Date("2026-08-30T22:15:00.000Z"), 1).reason, "refresh_invalid", "refresh:invalid-return");
  rejects(() => kstInstant("2026-02-30", 7, 15), "DAILY_LOOP_DATE_INVALID", "date:accessor-safe");

  const refreshAt = new Date("2026-08-30T22:15:00.000Z");
  const refreshBase = { schema_version: 1, refresh_id: "r", state: "completed", completed_at: "2026-08-30T22:14:00.000Z", protocol_version: 1, capped: false };
  const refreshCases = [
    [refreshBase, "refresh_fresh"], [{ ...refreshBase, state: "failed" }, "refresh_failed"], [null, "refresh_missing"],
    [{ ...refreshBase, completed_at: "2026-08-30T20:00:00.000Z" }, "refresh_stale"], [{ ...refreshBase, protocol_version: 2 }, "refresh_incompatible"],
    [{ ...refreshBase, capped: true }, "refresh_capped"], [{ ...refreshBase, schema_version: 2 }, "refresh_invalid"],
  ];
  for (const [value, reason] of refreshCases) equal(evaluateRefreshContext(value, refreshAt, 60_000).reason, reason, `refresh:${reason}`);

  const identityDb = await open(); const identityAt = "2026-08-31T03:00:00.000Z"; const identityLoop = new DailyControlLoop(new DailyLoopStore(identityDb), options(() => new Date(identityAt)));
  const identityBase = { ...event(identityAt), critical: true, critical_reason: "reason" }; identityLoop.prepare(identityBase); equal(identityLoop.prepare(identityBase).kind, "prepared", "identity:repeat");
  for (const mutation of [{ occurred_at: "2026-08-31T03:00:00.001Z" }, { critical_reason: "changed" }, { items: 2 }, { work: 2 }, { bytes: 2 }, { critical_reason: "changed-again" }, { occurred_at: "2026-08-31T03:00:00.002Z" }, { items: 3 }]) {
    rejects(() => identityLoop.prepare({ ...identityBase, ...mutation }), "DAILY_LOOP_IDENTITY_CONFLICT", "identity:mutation"); identityConflicts++;
  }

  for (const owner of ["linux:stable", "linux:other"]) for (const delta of [-1, 0, 1]) {
    const db = await open(); let at = new Date("2026-08-30T22:15:00.000Z"); const firstLoop = new DailyControlLoop(new DailyLoopStore(db), options(() => at));
    const prepared = firstLoop.prepare({ kind: "scheduled" }); check(prepared.kind === "prepared", "lease:prepared"); if (prepared.kind !== "prepared") continue;
    const first = firstLoop.claim(prepared.run_id); at = new Date(Date.parse(first.lease_expires_at) + delta); const contenderDb = new AuthorityDb(db.filename); const other = new DailyControlLoop(new DailyLoopStore(contenderDb), options(() => at, { owner_id: owner }));
    if (delta < 0) rejects(() => other.claim(prepared.run_id), "DAILY_LOOP_LEASE_ACTIVE", "lease:-1"); else equal(other.claim(prepared.run_id).fence, 2, "lease:reclaim"); contenderDb.close();
  }
  const raceDb = await open(); const raceAt = new Date("2026-08-30T22:15:00.000Z"); const raceLoop = new DailyControlLoop(new DailyLoopStore(raceDb), options(() => raceAt)); const racePrepared = raceLoop.prepare({ kind: "scheduled" }); check(racePrepared.kind === "prepared", "race:prepared");
  if (racePrepared.kind === "prepared") { const results = await workerRace(raceDb.filename, racePrepared.run_id, raceAt.toISOString()); equal(results.filter(result => result.ok).length, 1, "race:winner"); equal(results.filter(result => !result.ok).map(result => result.code), ["DAILY_LOOP_LEASE_ACTIVE"], "race:typed-loser"); equal(raceDb.db.prepare("SELECT sequence,lease_fence FROM daily_loop_checkpoints WHERE run_id=?").all(racePrepared.run_id), [{ sequence: 1, lease_fence: 1 }], "race:single-append"); }
  const reclaimRaceDb = await open(); const reclaimAt = new Date("2026-08-30T22:15:00.000Z"); const reclaimLoop = new DailyControlLoop(new DailyLoopStore(reclaimRaceDb), options(() => reclaimAt)); const reclaimPrepared = reclaimLoop.prepare({ kind: "scheduled" }); check(reclaimPrepared.kind === "prepared", "reclaim-race:prepared"); if (reclaimPrepared.kind === "prepared") { const first = reclaimLoop.claim(reclaimPrepared.run_id); const results = await workerRace(reclaimRaceDb.filename, reclaimPrepared.run_id, first.lease_expires_at); equal(results.filter(result => result.ok).map(result => result.fence), [2], "reclaim-race:winner"); equal(results.filter(result => !result.ok).map(result => result.code), ["DAILY_LOOP_LEASE_ACTIVE"], "reclaim-race:typed-loser"); equal(reclaimRaceDb.db.prepare("SELECT sequence,lease_fence FROM daily_loop_checkpoints WHERE run_id=?").all(reclaimPrepared.run_id), [{ sequence: 1, lease_fence: 2 }], "reclaim-race:single-append"); }

  const recoveryDb = await open(); const recoveryAt = new Date("2026-08-31T23:00:00.000Z"); const recoveryLoop = new DailyControlLoop(new DailyLoopStore(recoveryDb), options(() => recoveryAt, { recovery_lookback_days: 3 })); const recovery = await recoveryLoop.startup(); equal(recovery.prepared.length, 5, "recovery:five"); equal(dailyCounts(recoveryDb), { runs: 5, steps: 8, checkpoints: 15 }, "recovery:counts"); const recoveryCounts = dailyCounts(recoveryDb); await recoveryLoop.startup(); equal(dailyCounts(recoveryDb), recoveryCounts, "recovery:repeat");

  const deferDb = await open(); let deferAt = new Date("2026-08-31T13:00:00.000Z"); const deferLoop = new DailyControlLoop(new DailyLoopStore(deferDb), options(() => deferAt)); const deferred = deferLoop.prepare(event(deferAt.toISOString())); check(deferred.kind === "deferred", "defer:created"); if (deferred.kind === "deferred") { deferAt = new Date(deferred.next_allowed_at); const result = await deferLoop.cycle(); equal(result.completed_run_ids, [deferred.run_id], "defer:admit"); equal(dailyCounts(deferDb), { runs: 1, steps: 1, checkpoints: 6 }, "defer:counts"); deferredAdmissions = result.completed_run_ids.length; }

  const staleUncertainDb = await open(); let staleAt = new Date("2026-08-30T22:15:00.000Z"); const staleLoop = new DailyControlLoop(new DailyLoopStore(staleUncertainDb), options(() => staleAt)); const stalePrepared = staleLoop.prepare({ kind: "scheduled" }); check(stalePrepared.kind === "prepared", "uncertain:stale-prepared"); if (stalePrepared.kind === "prepared") { const staleClaim = staleLoop.claim(stalePrepared.run_id); staleAt = new Date(staleClaim.lease_expires_at); staleLoop.claim(stalePrepared.run_id); rejects(() => staleLoop.markUncertain(staleClaim, "EXECUTION_OUTCOME_UNCERTAIN"), "DAILY_LOOP_STALE_LEASE", "uncertain:stale"); }
  const uncertainDb = await open(); let uncertainAt = new Date("2026-08-30T22:15:00.000Z"); const uncertainLoop = new DailyControlLoop(new DailyLoopStore(uncertainDb), options(() => uncertainAt)); const uncertainPrepared = uncertainLoop.prepare({ kind: "scheduled" }); check(uncertainPrepared.kind === "prepared", "uncertain:prepared"); if (uncertainPrepared.kind === "prepared") { const claim = uncertainLoop.claim(uncertainPrepared.run_id); uncertainLoop.markUncertain(claim, "EXECUTION_OUTCOME_UNCERTAIN"); equal(uncertainDb.db.prepare("SELECT state FROM daily_loop_runs").get(), { state: "uncertain" }, "uncertain:current"); equal(dailyCounts(uncertainDb), { runs: 1, steps: 2, checkpoints: 1 }, "uncertain:counts"); uncertainRuns = uncertainDb.db.prepare("SELECT count(*) AS n FROM daily_loop_runs WHERE state='uncertain'").get().n; rejects(() => uncertainLoop.markUncertain(claim, "EXECUTION_OUTCOME_UNCERTAIN"), "DAILY_LOOP_STALE_LEASE", "uncertain:duplicate"); }

  for (const dimension of ["items", "work", "bytes"]) for (const maximum of [1, 2, 3]) {
    const db = await open(); const at = new Date("2026-08-31T03:00:00.000Z"); let events = [event(at.toISOString(), { [dimension]: 2 })]; const budgets = { max_items: 8, max_work: 8, max_bytes: 8, [`max_${dimension}`]: maximum };
    const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at, { budgets, event_source: { drain: () => { const result = events; events = []; return result; } } })); await loop.cycle(); equal(db.db.prepare("SELECT state FROM daily_loop_runs WHERE phase='in_day'").get().state, maximum < 2 ? "failed" : "completed", `budget:${dimension}:${maximum}`);
  }
  for (const malformed of [-1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) rejects(() => boundaryLoop.prepare(event("2026-08-31T03:00:00.000Z", { items: malformed })), "DAILY_LOOP_EVENT_INVALID", "budget:invalid");

  for (const delta of [-1, 0, 1]) { const db = await open(); let at = new Date("2026-08-31T03:00:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at, { deadline_ms: 10 })); const prepared = loop.prepare(event(at.toISOString())); check(prepared.kind === "prepared", "deadline:prepared"); if (prepared.kind !== "prepared") continue; const claim = loop.claim(prepared.run_id); at = new Date(Date.parse(claim.deadline_at) + delta); if (delta < 0) check(loop.runNext(claim), "deadline:-1"); else if (delta === 0) check(!loop.runNext(claim), "deadline:equal"); else rejects(() => loop.runNext(claim), "DAILY_LOOP_STALE_LEASE", "deadline:+1"); }
  const zeroDb = await open(); const zeroAt = new Date("2026-08-31T03:00:00.000Z"); let zeroEvents = [event(zeroAt.toISOString())]; const zeroLoop = new DailyControlLoop(new DailyLoopStore(zeroDb), options(() => zeroAt, { deadline_ms: 0, event_source: { drain: () => { const result = zeroEvents; zeroEvents = []; return result; } } })); await zeroLoop.cycle(); equal(zeroDb.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE phase='in_day'").get(), { state: "failed", failure_code: "DEADLINE_EXHAUSTED" }, "deadline:zero"); equal(dailyCounts(zeroDb), { runs: 1, steps: 1, checkpoints: 1 }, "deadline:zero-counts");
  for (const malformed of [-1, 1.5, 86_400_001]) rejects(() => new DailyControlLoop(new DailyLoopStore(boundaryDb), options(() => refreshAt, { deadline_ms: malformed })), "DAILY_LOOP_CONFIG_INVALID", "deadline:invalid");

  const parityCode = "import{classifyDailyLoopInstant,kstInstant}from'orca-jarvis-shadow';process.stdout.write(JSON.stringify([classifyDailyLoopInstant(new Date('2026-08-30T22:15:00.000Z'),{kind:'scheduled'}),kstInstant('2028-02-29',7,15).toISOString()]));";
  const parity = (TZ, LC_ALL) => execFileSync(process.execPath, ["--input-type=module", "-e", parityCode], { cwd: packageRoot, env: { ...process.env, TZ, LC_ALL }, encoding: "utf8" });
  const utc = parity("UTC", "C"); const honolulu = parity("Pacific/Honolulu", "C.UTF-8"); equal(utc, honolulu, "parity:bytes"); check(utc.includes("morning"), "parity:morning"); check(utc.includes("2028-02-28"), "parity:leap"); equal(hash(utc), hash(honolulu), "parity:hash");
}

async function schemaMatrix() {
  const upgrade = migrationFixture(false); const upgradeDb = new AuthorityDb(upgrade.path, upgrade.migrations); databases.push(upgradeDb); await upgradeDb.migrate();
  const T0 = "2026-08-28T00:00:00.000Z", T1 = "2026-08-28T00:01:00.000Z", T4 = "2026-08-28T00:04:00.000Z", T5 = "2026-08-28T00:05:00.000Z";
  const insertLegacy = (id, state) => { upgradeDb.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`dlr:${id}`, "2026-08-28", `corr:${id}`, `idem:${id}`, "pending", 0, T5, T0, T0); if (state === "pending") return; if (state === "failed") { upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='failed',failure_code='MISSED_RECOVERY_WINDOW',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); return; } upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='legacy',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id=?").run(T4, T1, `dlr:${id}`); if (state === "claimed") return; if (state === "uncertain") { upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='uncertain',failure_code='legacy',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); return; } upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); if (state === "running") return; upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); upgradeDb.db.prepare("UPDATE daily_loop_runs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=?").run(hash(id), T1, `dlr:${id}`); };
  for (const state of ["pending", "claimed", "running", "completed", "failed", "uncertain"]) insertLegacy(state, state);
  upgradeDb.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:legacy','dlr:running',1,'legacy','pending',?,?)").run(T0, T0); upgradeDb.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES('dlc:legacy','dlr:running',1,'running',?,1,?,?)").run(hash("legacy"), T4, T1);
  const legacyHash = hash(canonicalize(upgradeDb.db.prepare("SELECT run_id,loop_date,state,lease_owner,lease_fence,lease_expires_at,expires_at,result_digest,failure_code,created_at,updated_at FROM daily_loop_runs ORDER BY run_id").all())); cpSync(join(packageRoot, "dist", "migrations", "035_daily_loop_durable_guards.sql"), join(upgrade.migrations, "035_daily_loop_durable_guards.sql")); await upgradeDb.migrate(); equal(hash(canonicalize(upgradeDb.db.prepare("SELECT run_id,loop_date,state,lease_owner,lease_fence,lease_expires_at,expires_at,result_digest,failure_code,created_at,updated_at FROM daily_loop_runs ORDER BY run_id").all())), legacyHash, "upgrade:bytes"); equal(upgradeDb.db.prepare("SELECT record_version,count(*) AS n FROM daily_loop_runs GROUP BY record_version").all(), [{ record_version: 0, n: 6 }], "upgrade:versions"); equal(upgradeDb.db.prepare("SELECT legacy_run_count,legacy_step_count,legacy_checkpoint_count,invalid_checkpoint_count FROM daily_loop_migration_035_evidence").get(), { legacy_run_count: 6, legacy_step_count: 1, legacy_checkpoint_count: 1, invalid_checkpoint_count: 0 }, "upgrade:evidence");
  for (const name of ["001_authority.sql", "033_personal_operations.sql", "034_recommendation_transition_identity.sql", "035_daily_loop_durable_guards.sql"]) { const fixture = migrationFixture(true); const mutated = new AuthorityDb(fixture.path, fixture.migrations); databases.push(mutated); await mutated.migrate(); writeFileSync(join(fixture.migrations, name), Buffer.concat([readFileSync(join(fixture.migrations, name)), Buffer.from("\n-- mutation\n")])); await rejectsAsync(() => mutated.assertMigrationsReady(), "MIGRATION_CHECKSUM_MISMATCH", `checksum:${name}`); }
  for (const corruption of ["fence999", "gap", "wrong", "cross", "expired"]) { const fixture = migrationFixture(false); const corrupt = new AuthorityDb(fixture.path, fixture.migrations); databases.push(corrupt); await corrupt.migrate(); for (const id of ["a", "b"]) { corrupt.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`dlr:${id}`, "2026-08-28", `corr:${id}`, `idem:${id}`, "pending", 0, T5, T0, T0); corrupt.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='legacy',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id=?").run(T4, T1, `dlr:${id}`); } const insertCheckpoint = (id, sequence, previous, fence = 1, lease = T4, step = null) => corrupt.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`dlc:${id}`, "dlr:a", step, sequence, "running", previous, hash(id), fence, lease, T1); if (corruption === "fence999") insertCheckpoint("bad", 1, null, 999); if (corruption === "gap") insertCheckpoint("gap", 2, hash("missing")); if (corruption === "wrong") { insertCheckpoint("head", 1, null); insertCheckpoint("wrong", 2, hash("other")); } if (corruption === "cross") { corrupt.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:b','dlr:b',1,'b','pending',?,?)").run(T0, T0); insertCheckpoint("cross", 1, null, 1, T4, "dls:b"); } if (corruption === "expired") insertCheckpoint("expired", 1, null, 1, T1); cpSync(join(packageRoot, "dist", "migrations", "035_daily_loop_durable_guards.sql"), join(fixture.migrations, "035_daily_loop_durable_guards.sql")); await rejectsAsync(() => corrupt.migrate(), "constraint", `corrupt:${corruption}`); equal(corrupt.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id='035_daily_loop_durable_guards.sql'").get(), { n: 0 }, `corrupt-journal:${corruption}`); }
  const db = await open(); const baseline = counts(db); const objectCount = db.db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n; const journalCount = db.db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n; await db.migrate(); equal(db.db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n, objectCount, "schema:second-objects"); equal(db.db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n, journalCount, "schema:second-journal");
  let at = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at)); const prepared = loop.prepare({ kind: "scheduled" }); check(prepared.kind === "prepared", "schema:prepared"); if (prepared.kind !== "prepared") return;
  const claim = loop.claim(prepared.run_id); const second = new AuthorityDb(db.filename); databases.push(second);
  try { second.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run("forged", prepared.run_id, 1, "completed", hash("forged"), 999, claim.lease_expires_at, at.toISOString()); staleWriteSuccesses++; } catch { staleWriteRejections++; }
  forgedRows = db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints WHERE checkpoint_id='forged'").get().n; equal(forgedRows, 0, "schema:forged");
  const adversaryDb = await open(); const adversaryLoop = new DailyControlLoop(new DailyLoopStore(adversaryDb), options(() => at)); const adversaryPrepared = adversaryLoop.prepare({ kind: "scheduled" }); check(adversaryPrepared.kind === "prepared", "adversary:prepared"); if (adversaryPrepared.kind === "prepared") { const adversaryClaim = adversaryLoop.claim(adversaryPrepared.run_id); new DailyLoopStore(adversaryDb).start(adversaryClaim, at); const head = adversaryDb.db.prepare("SELECT checkpoint_digest FROM daily_loop_checkpoints WHERE run_id=? AND sequence=1").get(adversaryPrepared.run_id).checkpoint_digest; const attempt = (id, sequence, previous, fence = 1, lease = adversaryClaim.lease_expires_at) => adversaryDb.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, adversaryPrepared.run_id, sequence, "failed", previous, hash(id), fence, lease, at.toISOString(), 1, "{}"); try { attempt("gap-attempt", 3, head); chainGaps++; } catch { check(true, "adversary:gap-rejected"); } const childMaterial = { run_id: adversaryPrepared.run_id, step_id: null, sequence: 2, state: "failed", previous_digest: head, lease_fence: 1, detail: {}, created_at: at.toISOString() }; adversaryDb.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("valid-child", adversaryPrepared.run_id, 2, "failed", head, hash(canonicalize(childMaterial)), 1, adversaryClaim.lease_expires_at, at.toISOString(), 1, "{}"); try { attempt("branch-attempt", 3, head); chainBranches++; } catch { check(true, "adversary:branch-rejected"); } for (const [id, fence, lease] of [["stale-attempt", 0, adversaryClaim.lease_expires_at], ["future-attempt", 2, adversaryClaim.lease_expires_at], ["lease-attempt", 1, "2026-08-30T22:16:00.001Z"]]) { try { attempt(id, 3, hash(canonicalize(childMaterial)), fence, lease); staleWriteSuccesses++; } catch { staleWriteRejections++; } } }
  loop.finish(claim);
  chainGaps += db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints c WHERE sequence>1 AND NOT EXISTS(SELECT 1 FROM daily_loop_checkpoints p WHERE p.run_id=c.run_id AND p.sequence=c.sequence-1 AND p.checkpoint_digest=c.previous_digest)").get().n;
  chainBranches += db.db.prepare("SELECT count(*) AS n FROM (SELECT run_id,previous_digest,count(*) AS children FROM daily_loop_checkpoints WHERE previous_digest IS NOT NULL GROUP BY run_id,previous_digest HAVING children>1)").get().n;
  equal(chainGaps, 0, "schema:gaps"); equal(chainBranches, 0, "schema:branches");
  const runs = db.db.prepare("SELECT input_json,input_digest FROM daily_loop_runs WHERE record_version=1").all(); for (const row of runs) if (hash(`orca-jarvis/daily-loop-input/v1\0${row.input_json}`) !== row.input_digest) digestMismatches++;
  const steps = db.db.prepare("SELECT detail_json,evidence_digest,result_digest,state FROM daily_loop_steps WHERE record_version=1").all(); for (const row of steps) { const detail = JSON.parse(row.detail_json); if (hash(canonicalize(detail)) !== row.evidence_digest) digestMismatches++; if (row.result_digest !== null && hash(canonicalize({ detail, state: "completed" })) !== row.result_digest) digestMismatches++; }
  const checkpoints = db.db.prepare("SELECT run_id,step_id,sequence,state,previous_digest,lease_fence,detail_json,created_at,checkpoint_digest FROM daily_loop_checkpoints WHERE record_version=1").all(); for (const row of checkpoints) { const material = { run_id: row.run_id, step_id: row.step_id, sequence: row.sequence, state: row.state, previous_digest: row.previous_digest, lease_fence: row.lease_fence, detail: JSON.parse(row.detail_json), created_at: row.created_at }; if (hash(canonicalize(material)) !== row.checkpoint_digest) digestMismatches++; }
  equal(digestMismatches, 0, "schema:digests");
  const after = counts(db); for (const [table, before] of baseline) if (!["daily_loop_runs", "daily_loop_steps", "daily_loop_checkpoints"].includes(table) && after.get(table) !== before) outOfScopeDeltas++;
  equal(outOfScopeDeltas, 0, "schema:scope");
  const triggerRows = database => database.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'daily_loop%' ORDER BY name").all(); const triggerHash = database => hash(JSON.stringify(triggerRows(database))); const permanentHash = triggerHash(db); equal(permanentHash, triggerHash(second), "schema:second-trigger-hash"); second.close(); const reopened = new AuthorityDb(db.filename); databases.push(reopened); equal(permanentHash, triggerHash(reopened), "schema:reopen-trigger-hash"); equal(reopened.db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'daily_loop%'").get(), { n: 0 }, "schema:temp-triggers");
  const source035 = readFileSync(join(packageRoot, "migrations", "035_daily_loop_durable_guards.sql")); const built035 = readFileSync(join(packageRoot, "dist", "migrations", "035_daily_loop_durable_guards.sql")); equal(hash(source035), hash(built035), "schema:built-migration");
}

async function integrityMatrix() {
  const db = await open();
  const at = new Date("2026-08-30T22:15:00.000Z");
  const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at));
  const prepared = loop.prepare({ kind: "scheduled" });
  check(prepared.kind === "prepared", "integrity:prepared");
  if (prepared.kind !== "prepared") return;
  const claim = loop.claim(prepared.run_id);
  const attacker = new AuthorityDb(db.filename); databases.push(attacker);
  const forgedDigest = `sha256:${"0".repeat(64)}`;
  attacker.db.prepare(
    "INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("dlc:forged-digest", prepared.run_id, null, 1, "running", null, forgedDigest, claim.fence,
    claim.lease_expires_at, at.toISOString(), 1, canonicalize("run_started"));
  attacker.close(); db.close();
  const reopened = new AuthorityDb(db.filename); databases.push(reopened);
  const before = dailyCounts(reopened);
  const beforeState = reopened.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id).state;
  const forged = reopened.db.prepare("SELECT * FROM daily_loop_checkpoints WHERE checkpoint_id='dlc:forged-digest'").get();
  const expected = hash(canonicalize({
    run_id: forged.run_id, step_id: forged.step_id, sequence: forged.sequence, state: forged.state,
    previous_digest: forged.previous_digest, lease_fence: forged.lease_fence,
    detail: JSON.parse(forged.detail_json), created_at: forged.created_at,
  }));
  forgedDigestMismatches = Number(expected !== forged.checkpoint_digest);
  rejects(() => new DailyLoopStore(reopened).start(claim, new Date(at.getTime() + 1)),
    "DAILY_LOOP_INTEGRITY_FAILURE", "integrity:reopen-start");
  integrityFailures++;
  const after = dailyCounts(reopened);
  appendedRows = after.checkpoints - before.checkpoints;
  stateDeltas = Number(reopened.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id).state !== beforeState);
  equal(appendedRows, 0, "integrity:zero-appends");
  equal(stateDeltas, 0, "integrity:zero-state-deltas");
  equal(forgedDigestMismatches, 1, "integrity:attack-proven");
}

async function main() {
  try {
    await behaviorMatrix(); await schemaMatrix(); await integrityMatrix();
    check(assertions >= 92, "assertion-floor"); equal(identityConflicts, 8, "identity-conflict-count"); equal(deferredAdmissions, 1, "deferred-count"); equal(uncertainRuns, 1, "uncertain-count"); equal(staleWriteSuccesses, 0, "stale-write-successes"); check(staleWriteRejections > 0, "stale-write-rejections");
    log(`TASK20_FINAL_HOTFIX_DRIVER_PASS assertions=${assertions} integrity_failures=${integrityFailures} appended_rows=${appendedRows} state_deltas=${stateDeltas} forged_digest_mismatches=${forgedDigestMismatches} identity_conflicts=${identityConflicts} deferred_admissions=${deferredAdmissions} uncertain_runs=${uncertainRuns} forged_rows=${forgedRows} stale_writes=${staleWriteSuccesses} stale_write_rejections=${staleWriteRejections} chain_gaps=${chainGaps} chain_branches=${chainBranches} digest_mismatches=${digestMismatches} out_of_scope_deltas=${outOfScopeDeltas}`);
  } finally {
    for (const db of databases.reverse()) { try { db.close(); } catch { /* already closed */ } }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

main().catch(failure => { errorLog(`TASK20_REMEDIATION_REQUEST_CHANGES ${failure instanceof Error ? failure.message : "unknown"}`); process.exitCode = 1; });
