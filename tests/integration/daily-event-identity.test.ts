import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore } from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import * as time from "../../src/daily-loop-time.js";

const at = new Date("2026-09-09T03:00:00.000Z");
const options = { time_zone: "Asia/Seoul" as const, owner_id: "identity", lease_ms: 60000, deadline_ms: 600000,
  recovery_window_ms: 7200000, recovery_lookback_days: 3, refresh_freshness_ms: 1800000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock: () => at,
  event_source: { drain: () => [] }, refresh_reader: { read: () => null } };
const event = (id: string, occurred = at.toISOString()) => ({ kind: "event", event_id: id, occurred_at: occurred,
  critical: false, items: 1, work: 1, bytes: 1 });
const snapshot = (db: AuthorityDb) => db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all();

it.each([false, true])("preserves distinct event identities and exact replay in either order: %s", async reverse => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const loop = new DailyControlLoop(new DailyLoopStore(db), options);
    const ids = reverse ? ["event_a", "event:a"] : ["event:a", "event_a"];
    const first = loop.prepare(event(ids[0]!)), second = loop.prepare(event(ids[1]!));
    expect(first).not.toEqual(second); expect(snapshot(db)).toHaveLength(2);
    const saved = snapshot(db);
    expect(loop.prepare(event(ids[0]!))).toEqual(first); expect(loop.prepare(event(ids[1]!))).toEqual(second);
    expect(snapshot(db)).toEqual(saved);
    expect(() => loop.prepare({ ...event(ids[0]!), work: 2 })).toThrow("DAILY_LOOP_IDENTITY_CONFLICT");
    expect(snapshot(db)).toEqual(saved);
  } finally { db.close(); }
});

it("reuses a persisted legacy key while allowing a different colliding event", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const loop = new DailyControlLoop(new DailyLoopStore(db), options);
    // Emulate the previous producer's key selection, with unchanged record/step formats.
    const old = vi.spyOn(time, "canonicalDailyLoopKey").mockImplementation(time.legacyDailyLoopKey);
    let original;
    try { original = loop.prepare(event("event:a")); } finally { old.mockRestore(); }
    const saved = snapshot(db);
    expect(new DailyControlLoop(new DailyLoopStore(db), options).prepare(event("event:a"))).toEqual(original);
    expect(snapshot(db)).toEqual(saved);
    expect(loop.prepare(event("event_a"))).not.toEqual(original);
    expect(snapshot(db)).toHaveLength(2);
    const row = saved[0] as Record<string, unknown>;
    const input = JSON.parse(String(row.input_json)); input.logical_key = "different-key";
    const json = canonicalize(input);
    const duplicate = { ...row, run_id: "duplicate-run", correlation_id: "duplicate-correlation",
      idempotency_key: "different-key", input_json: json,
      input_digest: `sha256:${createHash("sha256").update("orca-jarvis/daily-loop-input/v1\0").update(json).digest("hex")}` };
    const columns = Object.keys(duplicate);
    expect(() => db.db.prepare(`INSERT INTO daily_loop_runs(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
      .run(...columns.map(key => duplicate[key as keyof typeof duplicate]))).toThrow(/UNIQUE|daily_loop_event_identity_v2/);
  } finally { db.close(); }
});

it("separates deferred keys and refuses event preparation without the schema guard", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const loop = new DailyControlLoop(new DailyLoopStore(db), options);
    const quiet = "2026-09-09T14:00:00.000Z";
    const first = loop.prepare(event("event:a", quiet)), second = loop.prepare(event("event_a", quiet));
    expect(first.kind).toBe("deferred"); expect(second.kind).toBe("deferred"); expect(first).not.toEqual(second);
    expect(snapshot(db)).toHaveLength(2);
    db.db.exec("DROP INDEX daily_loop_event_identity_v2");
    expect(() => loop.prepare(event("new"))).toThrow("DAILY_LOOP_IDENTITY_CONFLICT");
    expect(snapshot(db)).toHaveLength(2);
  } finally { db.close(); }
});


it("preserves unknown version-zero identity on upgrade instead of creating a second run", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-event-upgrade-"));
  const prefix = join(root, "migrations"); mkdirSync(prefix);
  for (const name of readdirSync("migrations").filter(name => name.endsWith(".sql") && name < "035_")) {
    copyFileSync(join("migrations", name), join(prefix, name));
  }
  const path = join(root, "authority.sqlite"); let db = new AuthorityDb(path, prefix);
  try {
    await db.migrate();
    db.db.prepare(`INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,
      expires_at,created_at,updated_at) VALUES('legacy','2026-09-09','legacy',?,'pending',?,?,?)`)
      .run(time.legacyDailyLoopKey("2026-09-09", "in_day", "event:a"), "2026-09-09T03:10:00.000Z", at.toISOString(), at.toISOString());
    db.close(); db = new AuthorityDb(path, resolve("migrations")); await db.migrate();
    const saved = snapshot(db);
    const loop = new DailyControlLoop(new DailyLoopStore(db), options);
    for (const id of ["event:a", "event_a"]) expect(() => loop.prepare(event(id))).toThrow("DAILY_LOOP_IDENTITY_CONFLICT");
    expect(snapshot(db)).toEqual(saved);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("returns the stored legacy deferred key after upgrading the classifier", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const loop = new DailyControlLoop(new DailyLoopStore(db), options);
    const quiet = event("event:a", "2026-09-09T14:00:00.000Z");
    const old = vi.spyOn(time, "canonicalDailyLoopKey").mockImplementation(time.legacyDailyLoopKey);
    let original;
    try { original = loop.prepare(quiet); } finally { old.mockRestore(); }
    expect(original.kind).toBe("deferred");
    const saved = snapshot(db);
    const legacy = time.legacyDailyLoopKey("2026-09-10", "in_day", "event:a");
    expect(saved[0]).toMatchObject({ idempotency_key: legacy });
    expect(new DailyControlLoop(new DailyLoopStore(db), options).prepare(quiet))
      .toEqual({ ...original, deferred_key: legacy });
    expect(snapshot(db)).toEqual(saved);
  } finally { db.close(); }
});
