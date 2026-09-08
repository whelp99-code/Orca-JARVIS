import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { memoryReadHighWater } from "../../src/memory-read-fence.js";
import { AuthorityDb } from "../../src/db.js";
import { MemoryReadService } from "../../src/dashboard/memory-read-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { Task32ReadAdapter, TASK32_NOW, task32Evidence } from "../fixtures/task32-memory-test-support.js";

it.each(["search", "detail", "conflicts"] as const)("withholds %s if the owner session changes during provider I/O", async surface => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-memory-view-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  try {
    await db.migrate();
    let sessionId = "session:before";
    const session = { ...createDashboardSession(), authenticatedSessionId: () => sessionId };
    const record = task32Evidence();
    const adapter = new Task32ReadAdapter([{ ...record, record: { ...record.record!, generation: {
      ...record.record!.generation, tombstone_set_root: memoryReadHighWater(db).set_root } } }]);
    const tokens = new MemoryTokenCache(Buffer.alloc(32, 7), () => TASK32_NOW);
    const service = new MemoryReadService({ authority: db, adapter, tokens, session, clock: () => TASK32_NOW });
    const item = (await service.search("fixture", 20)).items[0]!;
    const before = surface === "detail" ? adapter.readPage.bind(adapter)
      : surface === "conflicts" ? adapter.openConflicts.bind(adapter) : adapter.search.bind(adapter);
    const changed = async () => { sessionId = "session:after"; return before("wiki/task32-1"); };
    if (surface === "detail") adapter.readPage = changed;
    else if (surface === "conflicts") adapter.openConflicts = changed;
    else adapter.search = changed;
    const request = surface === "detail" ? service.detail(item.record_token)
      : surface === "conflicts" ? service.conflicts(20) : service.search("fixture", 20);
    await expect(request).rejects.toMatchObject({ code: "MEMORY_SURFACE_READ_CHANGED" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("withholds a search if policy changes even when its records are not individually suppressed", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-memory-policy-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  try {
    await db.migrate();
    const adapter = new Task32ReadAdapter();
    adapter.search = async () => {
      db.db.prepare("UPDATE memory_surface_authority SET privacy_epoch=privacy_epoch+1 WHERE singleton_id=1").run();
      return { kind: "current", checked_at: TASK32_NOW.toISOString(), evidence: [task32Evidence()] };
    };
    const service = new MemoryReadService({ authority: db, adapter,
      tokens: new MemoryTokenCache(Buffer.alloc(32, 7), () => TASK32_NOW),
      session: createDashboardSession(), clock: () => TASK32_NOW });
    await expect(service.search("fixture", 20)).rejects.toMatchObject({ code: "MEMORY_SURFACE_READ_CHANGED" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
