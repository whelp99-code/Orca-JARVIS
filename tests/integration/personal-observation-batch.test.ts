import { expect, it } from "vitest";
import { AuthorityDb, normalizeAndPersistPersonalObservations, normalizePersonalObservations } from "../../src/index.js";
import { observationInput, OBSERVATION_CHECKED_AT } from "../fixtures/personal-observation-input.js";

it("rolls back the public normalization batch on a later SQL failure and supports retry/replay", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    db.db.exec(`CREATE TRIGGER fixture_batch_failure BEFORE INSERT ON personal_observations
      WHEN (SELECT COUNT(*) FROM personal_observations)=1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
    const run = () => normalizeAndPersistPersonalObservations({ input: observationInput(), store: db, persisted_at: OBSERVATION_CHECKED_AT });
    expect(run).toThrow("fixture failure");
    for (const table of ["personal_observations", "personal_source_checkpoints", "personal_context_audit_events"]) {
      // Every write belonging to the batch, including audit, must roll back.
      expect(db.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    db.db.exec("DROP TRIGGER fixture_batch_failure");
    expect(run().map(row => row.inserted)).toEqual([true, true, true, true]);
    const before = db.db.serialize();
    expect(run().map(row => row.inserted)).toEqual([false, false, false, false]);
    expect(db.db.serialize().equals(before)).toBe(true);
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});

it("rejects malformed and oversized batches and invalid empty-batch clocks without writes", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    const observation = normalizePersonalObservations(observationInput())[0]!;
    const before = db.db.serialize();
    expect(() => db.persistObservationBatch(Array(257).fill(observation), OBSERVATION_CHECKED_AT))
      .toThrow("PERSONAL_OBSERVATION_BATCH_INVALID");
    expect(() => db.persistObservationBatch([], "invalid")).toThrow("PERSONAL_TIME_INVALID");
    expect(() => db.persistObservationBatch([observation, null], OBSERVATION_CHECKED_AT)).toThrow("PERSONAL_OBSERVATION_INVALID");
    expect(db.persistObservationBatch([], OBSERVATION_CHECKED_AT)).toEqual([]);
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});

it("rolls back a successful nested batch when its owning transaction cannot settle", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    const before = db.db.serialize();
    expect(() => db.db.transaction(() => {
      db.persistObservationBatch(normalizePersonalObservations(observationInput()), OBSERVATION_CHECKED_AT);
      expect(db.db.prepare("SELECT COUNT(*) n FROM personal_observations").get()).toEqual({ n: 4 });
      throw new Error("owner settlement failure");
    }).immediate()).toThrow("owner settlement failure");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
