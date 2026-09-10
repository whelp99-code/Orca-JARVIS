import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { execute } from "../../src/cli.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { LocalTimelineRefreshService } from "../../src/local-timeline-refresh-service.js";
const at = "2026-09-09T01:00:00.000Z";
it("collects registered tasks, isolates missing/held subjects and throttles repeated cycles", async () => {
  const db = new AuthorityDb(":memory:", "migrations"); let now = at;
  try {
    await db.migrate();
    db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('a','task:live','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z')`);
    const store = new LocalTimelineSnapshotStore(db); store.register("task:live"); store.register("task:missing");
    store.register("task:held"); store.setHeld("task:held", true);
    const service = new LocalTimelineRefreshService(db, () => new Date(now));
    expect(service.cycle()).toMatchObject({ status: "partial", subjects: 3, attempted: 3, collected: 1, failed: 1, held: 1 });
    const before = db.db.serialize(); expect(service.cycle()).toBeUndefined(); expect(db.db.serialize().equals(before)).toBe(true);
    now = "2026-09-09T01:01:00.000Z"; expect(service.cycle()).toMatchObject({ collected: 1, failed: 1 });
    now = at; expect(() => service.cycle()).toThrow("LOCAL_COLLECTION_CLOCK_INVALID");
  } finally { db.close(); }
});
it("reports unprocessed subjects when the between-task budget expires", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); new LocalTimelineSnapshotStore(db).register("task:pending");
    const times = [at, at, "2026-09-09T01:00:30.000Z", "2026-09-09T01:00:30.000Z"];
    expect(new LocalTimelineRefreshService(db, () => new Date(times.shift()!)).cycle())
      .toMatchObject({ status: "partial", attempted: 0, remaining: 1 });
  } finally { db.close(); }
});
it("keeps service collection opt-in and continues coordinator status on a missing source", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-service-collection-")); const path = join(root, "db.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate(); new LocalTimelineSnapshotStore(db).register("task:missing");
    const args = ["service", "once", "--db", path]; const dependencies = { clock: () => new Date(at) };
    expect(await execute(args, dependencies)).not.toHaveProperty("local_collection");
    expect(await execute([...args, "--local-timeline-refresh"], dependencies))
      .toMatchObject({ state: "disconnected", local_collection: { status: "partial", failed: 1 } });
    await expect(execute(["service", "once", "--local-timeline-refresh"], dependencies))
      .rejects.toThrow("LOCAL_COLLECTION_CONFIG_INVALID");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("rejects clock rollback between subjects even when still after cycle start", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    const store = new LocalTimelineSnapshotStore(db);
    for (const id of ["task:first", "task:second"]) { store.register(id); store.setHeld(id, true); }
    const times = [at, at, "2026-09-09T01:00:20.000Z", "2026-09-09T01:00:10.000Z", "2026-09-09T01:00:20.000Z"];
    const service = new LocalTimelineRefreshService(db, () => new Date(times.shift()!));
    expect(() => service.cycle()).toThrow("LOCAL_COLLECTION_CLOCK_INVALID");
  } finally { db.close(); }
});
