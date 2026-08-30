import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore, classifyDailyLoopInstant, kstInstant } from "../../src/index.js";

type Fixture = { readonly root: string; readonly db: AuthorityDb };
const fixture = async (): Promise<Fixture> => { const root = mkdtempSync(join(tmpdir(), "task20-runtime-")); const db = new AuthorityDb(join(root, "authority.sqlite")); await db.migrate(); return { root, db }; };
const close = (value: Fixture): void => { value.db.close(); rmSync(value.root, { recursive: true, force: true }); };
const options = (clock: () => Date, overrides: Readonly<Record<string, unknown>> = {}) => ({
  time_zone: "Asia/Seoul" as const, owner_id: "linux:stable", lease_ms: 60_000, deadline_ms: 600_000,
  recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock,
  event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides,
});
const event = (at: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  kind: "event", event_id: "matrix", occurred_at: at, critical: false, items: 1, work: 1, bytes: 1, ...overrides,
});
const counts = (db: AuthorityDb): unknown => db.db.prepare("SELECT (SELECT count(*) FROM daily_loop_runs) AS runs,(SELECT count(*) FROM daily_loop_steps) AS steps,(SELECT count(*) FROM daily_loop_checkpoints) AS checkpoints").get();

describe("exact KST and date matrix", () => {
  it.each([
    ["2026-08-30T22:14:59.999Z", "scheduled", "not_due"], ["2026-08-30T22:15:00.000Z", "scheduled", "due"], ["2026-08-30T22:15:00.001Z", "scheduled", "not_due"],
    ["2026-08-31T12:29:59.999Z", "scheduled", "not_due"], ["2026-08-31T12:30:00.000Z", "scheduled", "due"], ["2026-08-31T12:30:00.001Z", "scheduled", "not_due"],
    ["2026-08-30T21:59:59.999Z", "event", "deferred"], ["2026-08-30T22:00:00.000Z", "event", "due"], ["2026-08-30T22:00:00.001Z", "event", "due"],
    ["2026-08-31T12:59:59.999Z", "event", "due"], ["2026-08-31T13:00:00.000Z", "event", "deferred"], ["2026-08-31T13:00:00.001Z", "event", "deferred"],
  ] as const)("classifies %s at %s as %s", (at, kind, expected) => {
    // Given / When
    const result = classifyDailyLoopInstant(new Date(at), kind === "scheduled" ? { kind } : event(at));
    // Then
    expect(result.kind).toBe(expected);
  });

  it.each(["0000-01-01", "2026-00-01", "2026-13-01", "2026-01-00", "2026-02-29", "2026-02-30"])("rejects impossible date %s", date => {
    // Given / When / Then
    expect(() => kstInstant(date, 7, 15)).toThrow("DAILY_LOOP_DATE_INVALID");
  });

  it("round-trips the valid leap day", () => {
    // Given / When / Then
    expect(kstInstant("2028-02-29", 7, 15).toISOString()).toBe("2028-02-28T22:15:00.000Z");
  });
});

describe("accessor-safe closed records", () => {
  it.each(["symbol", "non_enumerable", "custom_prototype", "nested_getter", "proxy"])("rejects hostile config %s without leaking", async kind => {
    // Given
    const f = await fixture(); const base = options(() => new Date("2026-08-30T22:15:00.000Z")); let invoked = 0; let hostile: unknown;
    if (kind === "symbol") hostile = { ...base, [Symbol("x")]: true };
    else if (kind === "non_enumerable") hostile = Object.defineProperty({ ...base }, "owner_id", { value: "linux:stable", enumerable: false });
    else if (kind === "custom_prototype") hostile = Object.assign(Object.create({ inherited: true }), base);
    else if (kind === "nested_getter") hostile = { ...base, budgets: Object.defineProperty({}, "max_items", { enumerable: true, get: () => { invoked++; throw new Error("getter"); } }) };
    else { const target = { ...base }; hostile = new Proxy(target, { ownKeys: () => { throw new Error("proxy"); } }); }
    // When / Then
    expect(() => Reflect.construct(DailyControlLoop, [new DailyLoopStore(f.db), hostile])).toThrow("DAILY_LOOP_CONFIG_INVALID");
    expect(invoked).toBe(0); close(f);
  });

  it.each(["symbol", "non_enumerable", "custom_prototype", "nested_getter", "proxy"])("rejects hostile event %s without writes", async kind => {
    // Given
    const f = await fixture(); const at = "2026-08-31T03:00:00.000Z"; const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => new Date(at))); const base = event(at); let invoked = 0; let hostile: unknown;
    if (kind === "symbol") hostile = { ...base, [Symbol("x")]: true };
    else if (kind === "non_enumerable") hostile = Object.defineProperty({ ...base }, "event_id", { value: "matrix", enumerable: false });
    else if (kind === "custom_prototype") hostile = Object.assign(Object.create({ inherited: true }), base);
    else if (kind === "nested_getter") hostile = Object.defineProperty({ ...base }, "items", { enumerable: true, get: () => { invoked++; throw new Error("getter"); } });
    else hostile = new Proxy(base, { getPrototypeOf: () => { throw new Error("proxy"); } });
    // When / Then
    expect(() => Reflect.apply(loop.prepare, loop, [hostile])).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(invoked).toBe(0); expect(counts(f.db)).toEqual({ runs: 0, steps: 0, checkpoints: 0 }); close(f);
  });
});

describe("complete identity, lease, recovery, defer, and uncertainty", () => {
  it.each([
    ["occurred_at", { occurred_at: "2026-08-31T03:00:00.001Z" }], ["critical", { critical: true, critical_reason: "urgent" }],
    ["items", { items: 2 }], ["work", { work: 2 }], ["bytes", { bytes: 2 }],
  ])("conflicts when %s changes under one logical event key", async (_name, mutation) => {
    // Given
    const f = await fixture(); const at = "2026-08-31T03:00:00.000Z"; const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => new Date(at))); loop.prepare(event(at)); const before = counts(f.db);
    // When / Then
    expect(() => loop.prepare(event(at, mutation))).toThrow("DAILY_LOOP_IDENTITY_CONFLICT"); expect(counts(f.db)).toEqual(before); close(f);
  });

  it("conflicts on scheduled instant, created time, not-before, deadline, and step bytes", async () => {
    // Given
    const f = await fixture(); const store = new DailyLoopStore(f.db); const due = { kind: "due" as const, local_date: "2026-08-31", phase: "morning" as const, scheduled_at: "2026-08-30T22:15:00.000Z" }; const created = new Date(due.scheduled_at); const deadline = new Date("2026-09-01T22:15:00.000Z"); const steps = [{ key: "one", sequence: 1 }]; store.prepare({ due, created_at: created, deadline_at: deadline, steps }); const before = counts(f.db);
    // When / Then
    for (const mutation of [
      { due: { ...due, scheduled_at: "2026-08-30T22:15:00.001Z" }, created_at: created, deadline_at: deadline, steps },
      { due, created_at: new Date("2026-08-30T22:15:00.001Z"), deadline_at: deadline, steps },
      { due: { ...due, not_before: "2026-08-30T22:15:00.001Z" }, created_at: created, deadline_at: deadline, steps },
      { due, created_at: created, deadline_at: new Date("2026-09-01T22:15:00.001Z"), steps },
      { due, created_at: created, deadline_at: deadline, steps: [{ key: "changed", sequence: 1 }] },
    ]) { expect(() => store.prepare(mutation)).toThrow("DAILY_LOOP_IDENTITY_CONFLICT"); expect(counts(f.db)).toEqual(before); } close(f);
  });

  it.each(["same", "different"] as const)("enforces %s-owner -1/equality/+1 reclaim boundaries", async ownerKind => {
    // Given
    for (const delta of [-1, 0, 1]) { const f = await fixture(); let at = new Date("2026-08-30T22:15:00.000Z"); const firstLoop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at)); const prepared = firstLoop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const first = firstLoop.claim(prepared.run_id); at = new Date(Date.parse(first.lease_expires_at) + delta); const owner = ownerKind === "same" ? "linux:stable" : "linux:other"; const otherDb = new AuthorityDb(f.db.filename); const contender = new DailyControlLoop(new DailyLoopStore(otherDb), options(() => at, { owner_id: owner }));
      // When / Then
      if (delta < 0) expect(() => contender.claim(prepared.run_id)).toThrow("DAILY_LOOP_LEASE_ACTIVE"); else expect(contender.claim(prepared.run_id).fence).toBe(2); otherDb.close(); close(f); }
  });

  it("scans three dates, classifies every schedule, and repeats with zero delta", async () => {
    // Given
    const f = await fixture(); const at = new Date("2026-08-31T23:00:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at, { recovery_lookback_days: 3 }));
    // When
    const first = await loop.startup(); const before = counts(f.db); const second = await loop.startup();
    // Then
    expect(first).toMatchObject({ recovery_from_date: "2026-08-30", recovery_through_date: "2026-09-01" }); expect(first.prepared).toHaveLength(5); expect(second.prepared).toHaveLength(5); expect(counts(f.db)).toEqual(before); close(f);
  });

  it("admits a durable deferred event only at equality without redelivery and rejects conflict", async () => {
    // Given
    const f = await fixture(); let at = new Date("2026-08-31T13:00:00.000Z"); const sourceEvent = event(at.toISOString()); const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at)); const deferred = loop.prepare(sourceEvent); if (deferred.kind !== "deferred") throw new Error("not deferred");
    // When / Then
    expect(() => loop.prepare(event(at.toISOString(), { bytes: 2 }))).toThrow("DAILY_LOOP_IDENTITY_CONFLICT"); at = new Date(Date.parse(deferred.next_allowed_at) - 1); expect((await loop.cycle()).completed_run_ids).toHaveLength(0); expect(f.db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get()).toEqual({ n: 0 }); at = new Date(deferred.next_allowed_at); expect((await loop.cycle()).completed_run_ids).toEqual([deferred.run_id]); const settled = counts(f.db); at = new Date(at.getTime() + 1); expect((await loop.cycle()).completed_run_ids).toHaveLength(0); expect(counts(f.db)).toEqual(settled); close(f);
  });

  it("rejects stale and expired uncertain claims and keeps duplicate terminal immutable", async () => {
    // Given
    const f = await fixture(); let at = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at)); const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const first = loop.claim(prepared.run_id); at = new Date(first.lease_expires_at); const current = loop.claim(prepared.run_id);
    // When / Then
    expect(() => loop.markUncertain(first, "EXECUTION_OUTCOME_UNCERTAIN")).toThrow("DAILY_LOOP_STALE_LEASE"); at = new Date(current.lease_expires_at); expect(() => loop.markUncertain(current, "EXECUTION_OUTCOME_UNCERTAIN")).toThrow("DAILY_LOOP_STALE_LEASE"); at = new Date(Date.parse(current.lease_expires_at) - 1); loop.markUncertain(current, "EXECUTION_OUTCOME_UNCERTAIN"); const before = counts(f.db); expect(() => loop.markUncertain(current, "EXECUTION_OUTCOME_UNCERTAIN")).toThrow(); expect(counts(f.db)).toEqual(before); close(f);
  });
});

describe("budget, deadline, and environment parity", () => {
  it.each(["items", "work", "bytes"] as const)("enforces %s N-1/N/N+1", async dimension => {
    // Given / When / Then
    for (const maximum of [1, 2, 3]) { const f = await fixture(); const at = new Date("2026-08-31T03:00:00.000Z"); const budgets = { max_items: 8, max_work: 8, max_bytes: 8, [`max_${dimension}`]: maximum }; let events: unknown[] = [event(at.toISOString(), { [dimension]: 2 })]; const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at, { budgets, event_source: { drain: () => { const result = events; events = []; return result; } } })); await loop.cycle(); expect(f.db.db.prepare("SELECT state FROM daily_loop_runs WHERE phase='in_day'").get()).toEqual({ state: maximum < 2 ? "failed" : "completed" }); close(f); }
  });

  it.each([-1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])("rejects malformed event cost %s", async value => {
    // Given
    const f = await fixture(); const at = "2026-08-31T03:00:00.000Z"; const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => new Date(at)));
    // When / Then
    expect(() => loop.prepare(event(at, { items: value }))).toThrow("DAILY_LOOP_EVENT_INVALID"); expect(counts(f.db)).toEqual({ runs: 0, steps: 0, checkpoints: 0 }); close(f);
  });

  it.each([-1, 1.5, 86_400_001, Number.NaN, Number.POSITIVE_INFINITY])("rejects malformed deadline %s before writes", async deadline => {
    // Given
    const f = await fixture();
    // When / Then
    expect(() => Reflect.construct(DailyControlLoop, [new DailyLoopStore(f.db), options(() => new Date("2026-08-30T22:15:00.000Z"), { deadline_ms: deadline })])).toThrow("DAILY_LOOP_CONFIG_INVALID"); expect(counts(f.db)).toEqual({ runs: 0, steps: 0, checkpoints: 0 }); close(f);
  });

  it.each([-1, 0, 1])("enforces deadline delta %i without work at or after equality", async delta => {
    // Given
    const f = await fixture(); let at = new Date("2026-08-31T03:00:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(f.db), options(() => at, { deadline_ms: 10 })); const prepared = loop.prepare(event(at.toISOString())); if (prepared.kind !== "prepared") throw new Error("not prepared"); const claim = loop.claim(prepared.run_id); at = new Date(Date.parse(claim.deadline_at) + delta);
    // When / Then
    if (delta < 0) expect(loop.runNext(claim)).toBe(true); else if (delta === 0) { expect(loop.runNext(claim)).toBe(false); expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get()).toEqual({ state: "failed", failure_code: "DEADLINE_EXHAUSTED" }); } else expect(() => loop.runNext(claim)).toThrow("DAILY_LOOP_STALE_LEASE"); close(f);
  });

  it("produces identical KST bytes across TZ and locale", () => {
    // Given
    const code = "import {classifyDailyLoopInstant,kstInstant} from 'orca-jarvis-shadow';process.stdout.write(JSON.stringify([classifyDailyLoopInstant(new Date('2026-08-30T22:15:00.000Z'),{kind:'scheduled'}),kstInstant('2028-02-29',7,15).toISOString()]));";
    const run = (TZ: string, LC_ALL: string): string => execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), env: { ...process.env, TZ, LC_ALL }, encoding: "utf8" });
    // When
    const first = run("UTC", "C"); const second = run("Pacific/Honolulu", "C.UTF-8");
    // Then
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(second).digest("hex"));
  });
});
