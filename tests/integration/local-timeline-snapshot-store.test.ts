import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { applyCurrentRestoreAuthority } from "../../src/memory-restore-authority.js";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
const at = "2026-09-09T01:00:00.000Z";
async function fixture(filename = ":memory:") {
  const db = new AuthorityDb(filename, "migrations"); await db.migrate();
  db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
    VALUES ('a','task:snapshot','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z')`);
  return db;
}
it("replaces snapshots without growing history and never substitutes newer bytes for an old ID", async () => {
  const db = await fixture();
  try {
    const store = new LocalTimelineSnapshotStore(db, () => new Date(at)); store.register("task:snapshot");
    const first = store.refresh("task:snapshot");
    const before = db.db.serialize(); expect(store.read("task:snapshot", first.collection_id).state).toBe("ready");
    expect(db.db.serialize().equals(before)).toBe(true);
    const second = store.refresh("task:snapshot");
    expect(second.collection_id).not.toBe(first.collection_id);
    expect(store.read("task:snapshot", first.collection_id)).toEqual({ state: "unavailable", reason: "snapshot_missing" });
    expect(db.db.prepare("SELECT count(*) n FROM local_timeline_subjects").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT count(*) n FROM personal_observations").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
it("preserves subject holds through expiry and release requires a new collection", async () => {
  const db = await fixture(); let now = at;
  try {
    const store = new LocalTimelineSnapshotStore(db, () => new Date(now)); store.register("task:snapshot");
    const first = store.refresh("task:snapshot"); now = "2026-09-09T01:05:00.000Z";
    expect(store.read("task:snapshot", first.collection_id)).toEqual({ state: "unavailable", reason: "stale" });
    expect(store.expire()).toBe(1); expect(store.expire()).toBe(0);
    store.setHeld("task:snapshot", true); store.register("task:snapshot"); store.expire();
    expect(() => store.refresh("task:snapshot")).toThrow("LOCAL_COLLECTION_HELD");
    store.setHeld("task:snapshot", false);
    expect(store.read("task:snapshot", first.collection_id).state).toBe("unavailable");
    expect(store.read("task:snapshot", store.refresh("task:snapshot").collection_id).state).toBe("ready");
  } finally { db.close(); }
});
it("enforces the total subject capacity without growing auxiliary receipts", async () => {
  const db = await fixture();
  try {
    const store = new LocalTimelineSnapshotStore(db);
    for (let i = 0; i < 64; i++) store.register(`task:${i}`);
    store.register("task:0");
    const before = db.db.serialize(); expect(() => store.register("task:65")).toThrow("LOCAL_COLLECTION_CAPACITY");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
it("rejects a hold/release during collection and invalidates changed source reads", async () => {
  const db = await fixture();
  try {
    let calls = 0;
    const store = new LocalTimelineSnapshotStore(db, () => {
      if (++calls === 2) { store.setHeld("task:snapshot", true); store.setHeld("task:snapshot", false); }
      return new Date(at);
    });
    store.register("task:snapshot");
    expect(() => store.refresh("task:snapshot")).toThrow("LOCAL_COLLECTION_SOURCE_CHANGED");
    const snapshot = store.refresh("task:snapshot");
    db.db.prepare(`INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at)
      VALUES ('a','fixture.event','{}',?)`).run(at);
    expect(store.read("task:snapshot", snapshot.collection_id)).toEqual({ state: "unavailable", reason: "source_changed" });
  } finally { db.close(); }
});

it("discards cached content through reconstruction and restore while preserving current holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-local-snapshot-"));
  const db = await fixture(join(root, "source.sqlite"));
  try {
    const store = new LocalTimelineSnapshotStore(db, () => new Date(at));
    store.register("task:snapshot"); store.refresh("task:snapshot");
    store.register("task:held"); store.setHeld("task:held", true);
    const rebuiltPath = join(root, "rebuilt.sqlite");
    await buildFreshAuthority(db, rebuiltPath);
    const rebuilt = new AuthorityDb(rebuiltPath, "migrations");
    try {
      expect(rebuilt.db.prepare("SELECT count(*) n FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL").get()).toEqual({ n: 0 });
      expect(rebuilt.db.prepare("SELECT held FROM local_timeline_subjects WHERE task_id='task:held'").get()).toEqual({ held: 1 });
      new LocalTimelineSnapshotStore(rebuilt).setHeld("task:held", false);
      applyCurrentRestoreAuthority(db, rebuilt);
      expect(rebuilt.db.prepare("SELECT held,snapshot_json FROM local_timeline_subjects WHERE task_id='task:held'").get())
        .toEqual({ held: 1, snapshot_json: null });
      expect(rebuilt.db.prepare("SELECT count(*) n FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL").get()).toEqual({ n: 0 });
      expect(rebuilt.db.pragma("foreign_key_check")).toEqual([]);
    } finally { rebuilt.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("does not publish or return a snapshot when source revalidation consumes its freshness window", async () => {
  const db = await fixture();
  try {
    const times = [at, at, at, "2026-09-09T01:05:00.000Z"];
    const late = new LocalTimelineSnapshotStore(db, () => new Date(times.shift()!));
    late.register("task:snapshot"); const before = db.db.serialize();
    expect(() => late.refresh("task:snapshot")).toThrow("LOCAL_COLLECTION_CLOCK_INVALID");
    expect(db.db.serialize().equals(before)).toBe(true);
    const store = new LocalTimelineSnapshotStore(db, () => new Date(at));
    const snapshot = store.refresh("task:snapshot");
    const readTimes = [at, "2026-09-09T01:05:00.000Z"];
    const reader = new LocalTimelineSnapshotStore(db, () => new Date(readTimes.shift()!));
    expect(reader.read("task:snapshot", snapshot.collection_id)).toEqual({ state: "unavailable", reason: "stale" });
  } finally { db.close(); }
});
