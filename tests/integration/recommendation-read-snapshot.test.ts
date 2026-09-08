import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { Recommendations } from "../../src/recommendations.js";
import { tempDb } from "../helpers.js";
import { persistTask18Context, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

it.each(["projection", "personal"] as const)("keeps %s validation on the snapshot that supplied its returned values", async kind => {
  const db = new AuthorityDb(tempDb()); await db.migrate();
  const created = new Recommendations(db).create(task18Request(persistTask18Context(db)));
  const other = new AuthorityDb(db.filename);
  const table = kind === "projection" ? "personal_recommendation_actions" : "personal_recommendations";
  const field = kind === "projection" ? "title" : "expires_at";
  const where = kind === "projection" ? " WHERE rank=1" : "";
  const row = other.db.prepare(`SELECT ${field} AS value FROM ${table}${where} LIMIT 1`).get() as { value: string };
  const original = row.value;
  other.db.exec(`DROP TRIGGER ${table}_immutable_update`);
  other.db.prepare(`UPDATE ${table} SET ${field}=?${where}`).run(kind === "projection" ? "unexpected-copy-marker" : "2026-08-28T13:01:00.000Z");
  const prepare = db.db.prepare.bind(db.db); let intercepted = 0;
  const spy = vi.spyOn(db.db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (kind === "projection" && sql.includes("WITH source_actions AS")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
        const result = all(...args); intercepted++;
        other.db.prepare(`UPDATE ${table} SET ${field}=?${where}`).run(original); return result;
      });
    } else if (kind === "personal" && sql.startsWith("SELECT recommendation_id,context_id,context_digest")) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
        const result = get(...args); intercepted++;
        other.db.prepare(`UPDATE ${table} SET ${field}=?${where}`).run(original); return result;
      });
    }
    return statement;
  }) as typeof db.db.prepare);
  try {
    const read = () => kind === "projection" ? new Recommendations(db).project(RECOMMENDATION_NOW)
      : db.getPersonalRecommendation(created.recommendation.id);
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    expect(read).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
    expect(intercepted).toBe(1); expect(db.db.inTransaction).toBe(false);
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    spy.mockRestore(); expect(read).not.toThrow();
  } finally { vi.restoreAllMocks(); other.close(); db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
});
