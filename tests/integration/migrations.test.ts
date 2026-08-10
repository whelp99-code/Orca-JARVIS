import { cpSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";

describe("migrations", () => {
  it("applies immutable forward migrations repeatedly", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); await db.migrate(); expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(19); });
  it("fails closed when migration is pending or its raw SQL bytes change", async () => { const pending = new AuthorityDb(tempDb()); await expect(pending.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" }); const directory = join(mkdtempSync(join(tmpdir(), "jarvis-migrations-")), "migrations"); cpSync(join(process.cwd(), "migrations"), directory, { recursive: true }); const db = new AuthorityDb(tempDb(), directory); await db.migrate(); appendFileSync(join(directory, "002_harden_authority.sql"), "\n-- byte change\n"); await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" }); });
});
