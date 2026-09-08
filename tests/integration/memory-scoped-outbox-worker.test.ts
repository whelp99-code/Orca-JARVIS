import { expect, it } from "vitest";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";

it("excludes another worker, reclaims an expired lease and spends only the new fence", async () => {
  const f = await scopedOutboxFixture();
  try {
    const registered = registerMemoryScopedOutbox(f.options, f.claimed);
    let now = f.now;
    const options = { ...f.options, roots: f.dispatch.roots, clock: () => now };
    const first = claimMemoryScopedOutbox(options, registered.outbox_id, "worker:a", 1000)!;
    expect(first.fence).toBe(1);
    expect(claimMemoryScopedOutbox(options, registered.outbox_id, "worker:b", 1000)).toBeUndefined();
    now = new Date(f.now.getTime() + 1000);
    const second = claimMemoryScopedOutbox(options, registered.outbox_id, "worker:b", 1000)!;
    expect(second.fence).toBe(2);
    expect(() => markMemoryScopedOutboxDispatch(options, first, 30000)).toThrow("MEMORY_OUTBOX_STALE_FENCE");
    const dispatch = markMemoryScopedOutboxDispatch(options, second, 30000);
    expect(dispatch.request.request_digest).toBe(registered.request_digest);
    expect(dispatch.request.source_request).toEqual(f.request);
    expect(() => markMemoryScopedOutboxDispatch(options, second, 30000)).toThrow("MEMORY_OUTBOX_STALE_FENCE");
    expect(claimMemoryScopedOutbox(options, registered.outbox_id, "worker:c", 1000)).toBeUndefined();
    expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_outbox_attempts").get()).toEqual({ n: 1 });
    expect(f.database.authority.db.prepare("SELECT state FROM memory_candidates").get()).toEqual({ state: "accepted_unsettled" });
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, now)).toBe(0);
    now = new Date(f.now.getTime() + 60000);
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, now)).toBe(1);
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, now)).toBe(0);
    expect(f.database.authority.db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
    expect(claimMemoryScopedOutbox(options, registered.outbox_id, "worker:c", 1000)).toBeUndefined();
    expect(() => markMemoryScopedOutboxDispatch(options, second, 30000)).toThrow("MEMORY_OUTBOX_STALE_FENCE");
    expect(f.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it("rolls back dispatch marker, candidate projection and audit when attempt insertion fails", async () => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed), db = f.database.authority.db;
    const options = { ...f.options, roots: f.dispatch.roots };
    const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:a", 1000)!;
    db.exec("CREATE TEMP TRIGGER injected_attempt_failure BEFORE INSERT ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => markMemoryScopedOutboxDispatch(options, lease, 1000)).toThrow("injected");
    expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "claimed" });
    expect(db.prepare("SELECT state FROM memory_candidates").get()).toEqual({ state: "queued" });
    db.exec("DROP TRIGGER injected_attempt_failure");
    expect(markMemoryScopedOutboxDispatch(options, lease, 1000).fence).toBe(1);
  } finally { closeMemoryDatabase(f.database); }
});
it("rechecks policy and lease expiry at dispatch and rejects invalid lease durations", async () => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed);
    let now = f.now, revoked = false;
    const options = { ...f.options, roots: f.dispatch.roots, clock: () => now,
      resolveWriteScope: (at: Date) => revoked ? undefined : f.options.resolveWriteScope(at) };
    for (const ms of [0, -1, NaN, Infinity, 900001]) expect(() => claimMemoryScopedOutbox(options, r.outbox_id, "worker:a", ms)).toThrow();
    const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:a", 1000)!;
    revoked = true;
    expect(() => markMemoryScopedOutboxDispatch(options, lease, 1000)).toThrow();
    revoked = false; now = new Date(f.now.getTime() + 1000);
    expect(() => markMemoryScopedOutboxDispatch(options, lease, 1000)).toThrow("MEMORY_OUTBOX_STALE_FENCE");
    expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_outbox_attempts").get()).toEqual({ n: 0 });
  } finally { closeMemoryDatabase(f.database); }
});
it("does not spend a dispatch when the current policy expires after its last reader check", async () => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed);
    const base = { ...f.options, roots: f.dispatch.roots };
    const lease = claimMemoryScopedOutbox(base, r.outbox_id, "worker:a", 1000)!;
    let resolutions = 0, clocksAfter = 0;
    const options = { ...base, clock: () => {
      if (resolutions === 2 && ++clocksAfter >= 2) return new Date(f.now.getTime() + 500);
      return f.now;
    }, resolveWriteScope: (at: Date) => {
      resolutions += 1;
      return { ...f.options.resolveWriteScope(at)!, valid_until: new Date(f.now.getTime() + 500).toISOString() };
    } };
    expect(() => markMemoryScopedOutboxDispatch(options, lease, 1000)).toThrow();
    expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_outbox_attempts").get()).toEqual({ n: 0 });
  } finally { closeMemoryDatabase(f.database); }
});
