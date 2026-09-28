import { generateKeyPairSync } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { DailyServiceCycles } from "../../src/daily-service-cycles.js";
import { tempDb } from "../helpers.js";

const MAC_AUTOMATION = "960f1c65-7f57-47e3-88f5-80bc5964ee7e";
const AT_0650 = new Date("2026-08-27T21:50:00.000Z");
const AT_0715 = new Date("2026-08-27T22:15:00.000Z");
const AT_0720 = new Date("2026-08-27T22:20:00.000Z");
const BEFORE_0700 = Date.parse("2026-08-27T22:00:00.000Z");
const SECTION_KEYS = ["now", "blocked", "decisions", "next_3", "workers", "risks"] as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const daily = {
  time_zone: "Asia/Seoul", lease_ms: 300_000, deadline_ms: 600_000, recovery_window_ms: 600_000,
  recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 8192 },
};

function cliFixture() {
  const path = tempDb(); const root = dirname(path); roots.push(root);
  const input = join(root, "daily.json");
  writeFileSync(input, JSON.stringify({ schema_version: 1, ...daily }));
  const db = new AuthorityDb(path); return db.migrate().then(() => { db.close();
    return { path, args: ["daily", "morning", "--once", "--db", path, "--input", input] as string[] }; });
}

function serviceFixture() {
  const path = tempDb(); const root = dirname(path); roots.push(root);
  const keys = generateKeyPairSync("ed25519");
  const key = join(root, "evening.pem");
  writeFileSync(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const input = join(root, "service.json");
  writeFileSync(input, JSON.stringify({ schema_version: 1, daily, source: { repository_identities: [], max_records: 10, max_bytes: 1_048_576 },
    trusted_key: { key_id: "native-cli", public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") } }));
  const db = new AuthorityDb(path);
  return db.migrate().then(() => ({ path, db, input, key }));
}

function count(path: string, table: string): number {
  const db = new AuthorityDb(path);
  try { return Number((db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); }
  finally { db.close(); }
}

function subscription(path: string): string | undefined {
  const db = new AuthorityDb(path);
  try {
    return (db.db.prepare("SELECT subscribed_at FROM morning_refresh_subscriptions").get() as { subscribed_at: string } | undefined)?.subscribed_at;
  } finally { db.close(); }
}

/** Virtual clock. `wait` is the only way time moves, so a oneshot cannot return before 07:20 without sleeping. */
function holdingClock(start: Date): { readonly now: () => Date; readonly wait: (ms: number) => Promise<void>; readonly at: () => Date } {
  let at = start;
  return {
    now: () => at,
    at: () => at,
    wait: (ms: number) => { at = new Date(at.getTime() + ms); return Promise.resolve(); },
  };
}

type OperatingBrief = {
  readonly refresh_subscription: string;
  readonly canonical_digest: string;
  readonly context_readiness: string;
  readonly degradation_reasons: readonly string[];
  readonly sections: { readonly next_3: readonly unknown[] };
};

function assertBrief(brief: OperatingBrief, digest?: string): void {
  expect(brief.refresh_subscription).toBe("before_07:00");
  expect(brief.context_readiness).not.toBe("ready");
  expect(brief.degradation_reasons).toContain("no_data");
  for (const key of SECTION_KEYS) expect(brief.sections).toHaveProperty(key);
  expect(brief.sections.next_3.length).toBeLessThanOrEqual(3);
  if (digest !== undefined) expect(brief.canonical_digest).toBe(digest);
}

it("one 07:15 morning command waits until 07:20 after the daily service subscribed", async () => {
  const f = await cliFixture();
  await execute(["service", "run", "--once", "--db", f.path], { clock: () => AT_0650 });
  expect(Date.parse(subscription(f.path) ?? "")).toBeLessThan(BEFORE_0700);
  const clock = holdingClock(AT_0715);
  const started = Date.now();
  const published = await execute(f.args, { clock: Object.assign(clock.now, { wait: clock.wait }) });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(clock.at().getTime()).toBeGreaterThanOrEqual(AT_0720.getTime());
  expect(published).toMatchObject({ ok: true, command: "daily.morning", run: { state: "completed" } });
  expect(published["held_for_refresh"]).toBeUndefined();
  const brief = published["operating_brief"] as OperatingBrief;
  assertBrief(brief);
  expect(count(f.path, "notification_intents")).toBe(1);
  expect(count(f.path, "workflow_runs")).toBe(0);
  expect(count(f.path, "control_command_requests")).toBe(0);
  expect(JSON.stringify(published)).not.toContain(MAC_AUTOMATION);
  expect(Date.parse(subscription(f.path) ?? "")).toBeLessThan(BEFORE_0700);
});

it("one 07:15 daily-service cycle waits until 07:20 and matches the morning digest", async () => {
  const left = await serviceFixture();
  const right = await cliFixture();
  try {
    await execute(["service", "run", "--once", "--db", right.path], { clock: () => AT_0650 });
    const rightClock = holdingClock(AT_0715);
    const twin = await execute(right.args, { clock: Object.assign(rightClock.now, { wait: rightClock.wait }) });
    let at = AT_0650;
    const wait = (ms: number) => { at = new Date(at.getTime() + ms); return Promise.resolve(); };
    const clock = Object.assign(() => at, { wait });
    const cycles = await DailyServiceCycles.fromFiles(left.db, left.input, left.key, clock);
    expect(Date.parse(subscription(left.path) ?? "")).toBeLessThan(BEFORE_0700);
    at = AT_0715;
    const started = Date.now();
    const published = await cycles.cycle();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(at.getTime()).toBeGreaterThanOrEqual(AT_0720.getTime());
    const brief = published.morning.status === "processed" ? published.morning.operating_brief ?? null : null;
    if (brief === null) throw new Error("MORNING_BRIEF_MISSING");
    assertBrief(brief, (twin["operating_brief"] as OperatingBrief).canonical_digest);
    expect(left.db.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 1 });
    expect(left.db.db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 0 });
    expect(left.db.db.prepare(`SELECT s.state FROM daily_loop_steps s
      JOIN daily_loop_runs r ON r.run_id=s.run_id
      WHERE s.step_key='morning_reconcile' AND r.loop_date='2026-08-28'`).get()).toEqual({ state: "completed" });
  } finally { left.db.close(); }
});
