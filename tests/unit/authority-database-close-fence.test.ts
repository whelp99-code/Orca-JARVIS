import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { closeSourceWithContentFence } from "../../src/authority-database-close-fence.js";
import * as content from "../../src/authority-database-content.js";
import { publishSwapBarrier, readSwapBarrier, releaseSwapBarrier } from "../../src/authority-database-swap-barrier.js";

it.each(["MEMORY", "LOCAL_RETENTION"] as const)("unwinds a failed %s post-close read and permits another attempt", prefix => {
  const root = mkdtempSync(join(tmpdir(), "authority-close-fence-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  const digest = content.authorityContentDigest;
  const spy = vi.spyOn(content, "authorityContentDigest")
    .mockImplementationOnce(digest).mockImplementationOnce(() => { throw new Error("INJECTED_READ_FAILURE"); });
  try {
    db.db.exec("CREATE TABLE value_under_test(value); INSERT INTO value_under_test VALUES(1)");
    publishSwapBarrier(db.filename, "memory_compaction", new Date());
    db.db.exec("BEGIN EXCLUSIVE");
    expect(() => closeSourceWithContentFence(db, prefix))
      .toThrow(`${prefix}_SOURCE_UNREADABLE_DURING_CLOSE`);
    expect(db.db.open).toBe(true);
    expect(db.db.inTransaction).toBe(false);
    expect(readSwapBarrier(db.filename)).toBeUndefined();
    expect(db.db.prepare("SELECT value FROM value_under_test").pluck().get()).toBe(1);
    spy.mockRestore();
    publishSwapBarrier(db.filename, "memory_compaction", new Date());
    db.db.exec("BEGIN EXCLUSIVE");
    expect(() => closeSourceWithContentFence(db, prefix)).not.toThrow();
    releaseSwapBarrier(db.filename);
    db.reopen();
    db.db.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    spy.mockRestore();
    releaseSwapBarrier(db.filename);
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
