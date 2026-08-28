import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

const MIGRATION = "031_control_ingress_idempotency.sql";
const CHECKSUM = "aa936566bcdec1b6d4823082d71f5e289e5b9a072a8936f78000678f57d9cd1f";

describe("control ingress migration", () => {
  it("is unique, ordered, checksummed, copied, and idempotent", async () => {
    // Given
    const source = join(process.cwd(), "migrations", MIGRATION);
    const names = readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort();

    // When
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    await db.migrate();

    // Then
    expect(names.indexOf(MIGRATION)).toBeLessThan(names.indexOf("033_personal_operations.sql"));
    expect(names.filter((name) => name.startsWith("031_"))).toEqual([MIGRATION]);
    expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(CHECKSUM);
    expect(readFileSync(join(process.cwd(), "dist", "migrations", MIGRATION))).toEqual(readFileSync(source));
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id=?")
      .get(MIGRATION)).toEqual({ count: 1 });
    expect(() => db.db.prepare("INSERT INTO control_ingress_requests(ingress_key,request_id,effect_key,payload_digest,created_at) VALUES(?,?,?,?,?)")
      .run("ingress:missing", "request:missing", "effect:one", "sha256:payload", "2026-08-28T00:00:00.000Z"))
      .toThrow();
    db.close();
  });
});
