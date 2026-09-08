import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";

it("upgrades existing retention jobs without inventing or permitting retroactive policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-retention-upgrade-"));
  const prefix = join(root, "migrations"); mkdirSync(prefix);
  for (const file of readdirSync("migrations").filter(file => /^\d+.*\.sql$/.test(file) && file < "074_")) {
    copyFileSync(join("migrations", file), join(prefix, file));
  }
  let db = new AuthorityDb(join(root, "authority.sqlite"), prefix);
  try {
    await db.migrate();
    const at = "2026-09-09T00:00:00.000Z";
    db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,not_before,expires_at,created_at,updated_at) " +
      "VALUES('old','old','old','notification','pending',?,'2026-09-10T00:00:00.000Z',?,?)").run(at, at, at);
    db.close(); db = new AuthorityDb(join(root, "authority.sqlite"), resolve("migrations"));
    await db.migrate();
    expect(db.db.prepare("SELECT policy_cutoff,state FROM retention_jobs WHERE job_id='old'").get())
      .toEqual({ policy_cutoff: null, state: "pending" });
    expect(() => db.db.prepare("UPDATE retention_jobs SET policy_cutoff=? WHERE job_id='old'").run(at))
      .toThrow("immutable retention policy cutoff");
    await db.migrate();
    expect(db.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
