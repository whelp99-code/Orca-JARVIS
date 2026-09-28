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

it("installs the refresh subscription from the morning CLI before 07:00 and holds the 07:15 run", async () => {
  const f = await cliFixture();
  const armed = await execute(f.args, { clock: () => AT_0650 });
  expect(armed).toMatchObject({ ok: true, command: "daily.morning", brief: null });
  expect(Date.parse(subscription(f.path) ?? "")).toBeLessThan(Date.parse("2026-08-27T22:00:00.000Z"));
  expect(count(f.path, "notification_intents")).toBe(0);
  const held = await execute(f.args, { clock: () => AT_0715 });
  expect(held).toMatchObject({ ok: true, held_for_refresh: true, operating_brief: null, brief: null });
  expect(count(f.path, "notification_intents")).toBe(0);
  const db = new AuthorityDb(f.path);
  try {
    expect(db.db.prepare("SELECT state FROM daily_loop_steps WHERE step_key='morning_reconcile'").get()).toEqual({ state: "pending" });
  } finally { db.close(); }
});

it("emits the cited brief from the morning CLI only once the 07:20 bound is reached", async () => {
  const left = await cliFixture();
  const right = await cliFixture();
  for (const f of [left, right]) {
    await execute(f.args, { clock: () => AT_0650 });
    await execute(f.args, { clock: () => AT_0715 });
  }
  const published = await execute(left.args, { clock: () => AT_0720 });
  const twin = await execute(right.args, { clock: () => AT_0720 });
  const brief = published["operating_brief"] as { sections: Record<string, unknown>; canonical_digest: string; context_readiness: string; degradation_reasons: string[] };
  expect(brief.context_readiness).not.toBe("ready");
  expect(brief.degradation_reasons).toContain("no_data");
  for (const key of SECTION_KEYS) expect(brief.sections).toHaveProperty(key);
  expect(Array.isArray(brief.sections["next_3"]) ? brief.sections["next_3"].length : 0).toBeLessThanOrEqual(3);
  expect(brief.canonical_digest).toBe((twin["operating_brief"] as { canonical_digest: string }).canonical_digest);
  expect(count(left.path, "notification_intents")).toBe(1);
  expect(count(left.path, "workflow_runs")).toBe(0);
  expect(count(left.path, "control_command_requests")).toBe(0);
  expect(JSON.stringify(published)).not.toContain(MAC_AUTOMATION);
});

it("holds the daily service morning cycle until 07:20 after a subscription installed before 07:00", async () => {
  const f = await serviceFixture();
  let at = AT_0650;
  try {
    const cycles = await DailyServiceCycles.fromFiles(f.db, f.input, f.key, () => at);
    await cycles.cycle();
    expect(Date.parse(subscription(f.path) ?? "")).toBeLessThan(Date.parse("2026-08-27T22:00:00.000Z"));
    at = AT_0715;
    const held = await cycles.cycle();
    expect(held.morning).toMatchObject({ status: "processed", operating_brief: null, result: { completed_run_ids: [] } });
    expect(f.db.db.prepare("SELECT state FROM daily_loop_steps WHERE step_key='morning_reconcile'").get()).toEqual({ state: "pending" });
    at = AT_0720;
    const published = await cycles.cycle();
    expect(published.morning.status).toBe("processed");
    const brief = published.morning.status === "processed" ? published.morning.operating_brief : null;
    expect(brief).toMatchObject({ context_readiness: "no_data" });
    for (const key of SECTION_KEYS) expect(brief?.sections).toHaveProperty(key);
    expect(brief?.sections.next_3.length).toBeLessThanOrEqual(3);
    expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});
