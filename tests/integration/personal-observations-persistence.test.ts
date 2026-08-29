import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { AuthorityDb } from "../../src/index.js";
import { observationInput } from "../fixtures/personal-observation-input.js";
import { tempDb } from "../helpers.js";

async function database(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  return db;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("row required");
  return value;
}

describe("Task 14 normalized observation persistence", () => {
  it("persists a normalized batch idempotently without private source rows", async () => {
    // Given: a migrated personal store and one stable structured input batch.
    const db = await database();
    const persist = publicApi.normalizeAndPersistPersonalObservations;
    // When: the same batch is persisted twice through the public seam.
    expect(persist).toBeTypeOf("function");
    if (persist === undefined) return;
    const first = persist({ input: observationInput(), store: db, persisted_at: "2026-08-28T12:00:00.000Z" });
    const replay = persist({ input: observationInput(), store: db, persisted_at: "2026-08-28T12:00:00.000Z" });
    // Then: source observations/checkpoints are unique and raw fields never reach canonical storage.
    expect(first.map(item => item.inserted)).toEqual([true, true, true, true]);
    expect(replay.map(item => item.inserted)).toEqual([false, false, false, false]);
    expect(record(db.db.prepare("SELECT COUNT(*) AS count FROM personal_observations").get())["count"]).toBe(4);
    expect(record(db.db.prepare("SELECT COUNT(*) AS count FROM personal_source_checkpoints").get())["count"]).toBe(4);
    const stored = db.db.prepare("SELECT canonical_envelope_json FROM personal_observations ORDER BY observation_id").all();
    expect(stored.every(row => !/(?:not persisted|preview|body|token|secret)/iu.test(String(record(row)["canonical_envelope_json"])))).toBe(true);
    db.close();
  });
});
