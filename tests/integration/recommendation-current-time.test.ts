import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { Recommendations } from "../../src/recommendations.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { tempDb } from "../helpers.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

let db: AuthorityDb;
let service: Recommendations;
let evidenceDigest: string;
beforeAll(async () => {
  db = new AuthorityDb(tempDb()); await db.migrate(); service = new Recommendations(db);
  evidenceDigest = service.create(task18Request(persistTask18Context(db))).evidence_digest;
});
beforeEach(() => db.db.exec("BEGIN"));
afterEach(() => db.db.exec("ROLLBACK"));
afterAll(() => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); });
const writes = () => db.db.prepare("SELECT total_changes() AS n").get();

it("excludes future recommendations from next actions and owner decisions until the exact creation time", () => {
  const before = writes(); const early = "2026-08-28T11:59:59.999Z";
  const projection = service.project(early);
  expect(projection.next_actions).toEqual([]); expect(projection.owner_decisions_needed).toEqual([]);
  expect(projection.lifecycle_actions).toHaveLength(3);
  expect(projection.lifecycle_actions.every(action => !action.current)).toBe(true);
  expect(todayProjection(db, new Date(early))).toMatchObject({ state: "no_data", next_actions: [], active_decision_count: 0 });
  expect(service.project(RECOMMENDATION_NOW).next_actions).toHaveLength(3); expect(writes()).toEqual(before);
});

it("does not expose a future accepted transition as a current action after clock rollback", () => {
  const accepted = "2026-08-28T12:01:00.000Z";
  service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
    evidence_digest: evidenceDigest, occurred_at: accepted });
  const before = writes(); const projection = service.project("2026-08-28T12:00:59.999Z");
  expect(projection.next_actions.map(action => action.rank)).toEqual([2, 3]);
  expect(projection.lifecycle_actions[0]).toMatchObject({ state: "accepted", current: false });
  expect(service.project(accepted).next_actions.map(action => action.rank)).toEqual([1, 2, 3]);
  expect(writes()).toEqual(before);
});
