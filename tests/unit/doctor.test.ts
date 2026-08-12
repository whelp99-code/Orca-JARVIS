import { describe, expect, it } from "vitest";
import { AuthorityDb, runDoctor } from "../../src/index.js";
import { tempDb } from "../helpers.js";

describe("doctor", () => {
  it("reports a healthy migrated database on the pinned runtime", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const report = await runDoctor(db, new Date());
    expect(report.ok).toBe(true);
    expect(report.runtime).toMatchObject({ abi: "137" });
    expect(report.database.applied_migrations).toBe(report.database.expected_migrations);
    expect(report.checks.find(check => check.name === "database.quick_check")).toMatchObject({ ok: true, actual: "ok" });
    db.close();
  });
  it("fails closed before migrations are applied", async () => {
    const db = new AuthorityDb(tempDb());
    const report = await runDoctor(db, new Date());
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === "database.migration_count")?.ok).toBe(false);
    db.close();
  });
});
