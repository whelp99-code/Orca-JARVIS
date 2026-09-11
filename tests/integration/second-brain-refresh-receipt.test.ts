import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { SecondBrainRefreshReceiptReader } from "../../src/second-brain-refresh-receipt.js";
import { tempDb } from "../helpers.js";

// CONTRACT TEST. No provider publishes this receipt yet: the profile below is JARVIS's proposal
// (docs/claude-second-brain-contract-handoff-2026-09-11.md). Passing here proves what this side
// accepts and refuses; it does not prove any provider produces it.
const PROFILE = "daily-refresh-receipt-v1";
const MORNING = new Date("2026-08-30T22:15:00.005Z");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Fixture = { readonly db: string; readonly root: string; readonly receipt: string;
  readonly args: (version: 1 | 2) => string[] };

async function fixture(): Promise<Fixture> {
  const db = tempDb();
  const root = dirname(db);
  roots.push(root);
  const receipt = join(root, "refresh-receipt.json");
  const base = {
    time_zone: "Asia/Seoul", lease_ms: 30000, deadline_ms: 60000, recovery_window_ms: 60000,
    recovery_lookback_days: 2, refresh_freshness_ms: 60000,
    budgets: { max_items: 10, max_work: 10, max_bytes: 1048576 },
  };
  const authority = new AuthorityDb(db);
  await authority.migrate();
  authority.close();
  return {
    db, root, receipt,
    args: (version: 1 | 2) => {
      const input = join(root, `daily-v${version}.json`);
      writeFileSync(input, JSON.stringify(version === 1
        ? { schema_version: 1, ...base }
        : { schema_version: 2, ...base, refresh_receipt_path: receipt }));
      return ["daily", "morning", "--once", "--db", db, "--input", input];
    },
  };
}

const publish = (path: string, receipt: unknown, profile = PROFILE): void =>
  writeFileSync(path, JSON.stringify({ schema_version: 1, profile, receipt }));

const completion = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1, refresh_id: "refresh:2026-08-30:1", state: "completed",
  completed_at: "2026-08-30T22:14:30.000Z", protocol_version: 1, capped: false, ...overrides,
});

const morning = async (fixture: Fixture, version: 1 | 2): Promise<Record<string, unknown>> =>
  await execute(fixture.args(version), { clock: () => MORNING }) as Record<string, unknown>;

it("keeps reporting no provider refresh for the configuration that never had the field", async () => {
  const f = await fixture();
  // The version 1 record is unchanged and still closed: adding the field to it is rejected.
  expect(await morning(f, 1)).toMatchObject({ ok: true, provider_refresh: "unavailable" });
}, 60_000);

it("reports the refresh state the run actually stored", async () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["fresh", completion()],
    ["capped", completion({ capped: true, refresh_id: "refresh:2026-08-30:capped" })],
    ["stale", completion({ completed_at: "2026-08-30T22:00:00.000Z",
      refresh_id: "refresh:2026-08-30:stale" })],
    ["incompatible", completion({ protocol_version: 2,
      refresh_id: "refresh:2026-08-30:incompatible" })],
    ["failed", completion({ state: "failed", refresh_id: "refresh:2026-08-30:failed" })],
    ["invalid", { schema_version: 1, refresh_id: "", state: "completed" }],
  ];
  for (const [expected, receipt] of cases) {
    const f = await fixture();
    publish(f.receipt, receipt);
    expect(await morning(f, 2), expected).toMatchObject({ ok: true, provider_refresh: expected });
  }
}, 120_000);

it("refuses a receipt from a profile this build never froze", async () => {
  const f = await fixture();
  publish(f.receipt, completion(), "daily-refresh-receipt-v2");
  // Refused before the loop sees it, so the run records no evidence rather than a foreign one.
  expect(await morning(f, 2)).toMatchObject({ ok: true, provider_refresh: "unavailable" });

  const reader = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(reader.read(MORNING)).toBeNull();
  expect(reader.lastOutcome()).toEqual({ state: "unsupported", reason: "profile",
    declared: "daily-refresh-receipt-v2" });
}, 60_000);

it("separates having no receipt from having one it cannot read", async () => {
  const f = await fixture();
  const absent = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(absent.read(MORNING)).toBeNull();
  expect(absent.lastOutcome()).toEqual({ state: "unreadable", reason: "absent" });

  expect(new SecondBrainRefreshReceiptReader(undefined).lastOutcome())
    .toEqual({ state: "unconfigured" });

  writeFileSync(f.receipt, "{ not json");
  const malformed = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(malformed.read(MORNING)).toBeNull();
  expect(malformed.lastOutcome())
    .toEqual({ state: "unsupported", reason: "envelope", declared: null });

  writeFileSync(f.receipt, JSON.stringify({ schema_version: 1, profile: PROFILE,
    receipt: completion(), extra: true }));
  const extra = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(extra.read(MORNING)).toBeNull();
  expect(extra.lastOutcome()).toEqual({ state: "unsupported", reason: "envelope", declared: PROFILE });

  writeFileSync(f.receipt, JSON.stringify({ schema_version: 1, profile: PROFILE,
    receipt: completion() }));
  const accepted = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(accepted.read(MORNING)).toMatchObject({ refresh_id: "refresh:2026-08-30:1" });
  expect(accepted.lastOutcome()).toEqual({ state: "received", profile: PROFILE,
    refresh_id: "refresh:2026-08-30:1" });
}, 60_000);

it("reads a regular file only, and one that fits the bound", async () => {
  const f = await fixture();
  const target = join(f.root, "actual-receipt.json");
  publish(target, completion());
  symlinkSync(target, f.receipt);
  const linked = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(linked.read(MORNING)).toBeNull();
  expect(linked.lastOutcome()).toEqual({ state: "unreadable", reason: "absent" });

  rmSync(f.receipt);
  writeFileSync(f.receipt, JSON.stringify({ schema_version: 1, profile: PROFILE,
    receipt: completion({ refresh_id: `refresh:${"9".repeat(9000)}` }) }));
  const oversized = new SecondBrainRefreshReceiptReader(f.receipt);
  expect(oversized.read(MORNING)).toBeNull();
  expect(oversized.lastOutcome()).toEqual({ state: "unreadable", reason: "too_large" });
}, 60_000);

it("refuses a configured path that is not absolute", async () => {
  const f = await fixture();
  const input = join(f.root, "daily-relative.json");
  writeFileSync(input, JSON.stringify({ schema_version: 2, time_zone: "Asia/Seoul", lease_ms: 30000,
    deadline_ms: 60000, recovery_window_ms: 60000, recovery_lookback_days: 2,
    refresh_freshness_ms: 60000, budgets: { max_items: 10, max_work: 10, max_bytes: 1048576 },
    refresh_receipt_path: "relative/receipt.json" }));
  const args = ["daily", "morning", "--once", "--db", f.db, "--input", input];
  await expect(execute(args, { clock: () => MORNING }))
    .rejects.toThrow("DAILY_LOOP_CONFIG_INVALID");
}, 60_000);
