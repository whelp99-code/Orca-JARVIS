import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, MorningBriefPublisher, MorningPublicationError } from "../../src/index.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { morningPublicationFixture, forgetSecondPublicationSource, PUBLICATION_AT, SECOND_SOURCE_TARGET } from "../fixtures/morning-publication.js";
import { tempDb } from "../helpers.js";
import { RECOMMENDATION_ID } from "../fixtures/recommendation-fixture.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
async function setup(options: Parameters<typeof morningPublicationFixture>[1] = {}) {
  const path = tempDb(); const db = new AuthorityDb(path); opened.push(db);
  return { db, path, ...await morningPublicationFixture(db, options) };
}
const writes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();
function publicationRows(db: AuthorityDb) {
  return {
    runs: db.db.prepare("SELECT * FROM daily_loop_runs").all(),
    steps: db.db.prepare("SELECT * FROM daily_loop_steps").all(),
    checkpoints: db.db.prepare("SELECT * FROM daily_loop_checkpoints").all(),
    dependencies: db.db.prepare("SELECT * FROM memory_projection_dependencies WHERE projection_kind IN ('daily_run','daily_step','morning_brief')").all(),
  };
}
describe("atomic morning publication", () => {
  it("stores a merged brief with all source dependencies and reads it after reopen without writes", async () => {
    const fixture = await setup(); const publisher = new MorningBriefPublisher(fixture.db, () => PUBLICATION_AT);
    const result = publisher.publish(fixture.claim, 1_048_576);
    expect(result).toMatchObject({ published: true, source_items: 6 }); expect(result.artifact_bytes).toBeGreaterThan(128);
    const dependencies = fixture.db.db.prepare(`SELECT projection_kind,COUNT(DISTINCT target_digest) AS n
      FROM memory_projection_dependencies WHERE projection_kind IN ('daily_run','daily_step','morning_brief') GROUP BY projection_kind`).all();
    expect(dependencies).toEqual([{ projection_kind: "daily_run", n: 2 }, { projection_kind: "daily_step", n: 2 }, { projection_kind: "morning_brief", n: 2 }]);
    expect(fixture.store.steps(fixture.run)[0]?.state).toBe("completed");
    const before = writes(fixture.db);
    expect(publisher.publish(fixture.claim, 1_048_576)).toMatchObject({ published: false });
    expect(writes(fixture.db)).toEqual(before);
    fixture.db.close(); opened.pop(); const reopened = new AuthorityDb(fixture.path); opened.push(reopened);
    const readBefore = writes(reopened);
    expect(todayProjection(reopened, PUBLICATION_AT)["brief"]).toMatchObject({ brief_id: result.brief_id, item_count: 1 });
    expect(writes(reopened)).toEqual(readBefore);
  });

  it("hides the stored merged brief when its nonrepresentative recommendation is deleted", async () => {
    const { db, claim } = await setup(); const result = new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576);
    expect(db.db.prepare("SELECT 1 FROM memory_projection_dependencies WHERE projection_kind='morning_brief' AND target_digest=?").get(SECOND_SOURCE_TARGET)).toBeDefined();
    forgetSecondPublicationSource(db);
    expect(new MemoryProjectionAuthority(db).isSuppressed({ kind: "morning_brief", id: result.brief_id!, component_id: result.brief_id! })).toBe(true);
    const before = writes(db);
    expect(todayProjection(db, PUBLICATION_AT)["brief"]).toMatchObject({ state: "no_data", item_count: 0 });
    expect(() => new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toThrow(MorningPublicationError);
    expect(writes(db)).toEqual(before);
  });

  it.each([{ lineage: false }, { phase: "evening" as const }, { date: "2026-08-29" }, { preceding: true }])(
    "rejects incomplete authority or incompatible run %j without partial publication", async options => {
      const { db, claim } = await setup(options); const before = publicationRows(db);
      expect(() => new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toThrow(MorningPublicationError);
      expect(publicationRows(db)).toEqual(before);
    },
  );

  it("requires the real preceding refresh step to complete", async () => {
    const { db, store, claim, run } = await setup({ preceding: true });
    store.start(claim, PUBLICATION_AT);
    store.completeStep({ claim, step: store.steps(run)[0], detail: { state: "ready" }, at: PUBLICATION_AT });
    expect(new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576).published).toBe(true);
  });

  it("does not skip a suppressed preceding step", async () => {
    const { db, store, claim, run } = await setup({ preceding: true });
    const preceding = store.steps(run)[0]!;
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "daily_step", id: preceding.step_id,
      component_id: preceding.step_id }, PUBLICATION_AT);
    const before = publicationRows(db);
    expect(() => new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toThrow(MorningPublicationError);
    expect(publicationRows(db)).toEqual(before);
  });

  it("enforces the actual artifact byte budget and stale claim", async () => {
    const { db, claim } = await setup(); const before = publicationRows(db); const publisher = new MorningBriefPublisher(db, () => PUBLICATION_AT);
    expect(() => publisher.publish(claim, 128)).toThrow(MorningPublicationError);
    expect(() => publisher.publish({ ...claim, fence: claim.fence + 1 }, 1_048_576)).toThrow(MorningPublicationError);
    expect(() => new MorningBriefPublisher(db, () => new Date(PUBLICATION_AT.getTime() - 1))
      .publish(claim, 1_048_576)).toThrow(MorningPublicationError);
    expect(publicationRows(db)).toEqual(before);
  });

  it("rolls back the completed step and checkpoint when lineage writes fail", async () => {
    const { db, claim } = await setup(); const before = publicationRows(db);
    db.db.exec("CREATE TRIGGER fail_brief_binding BEFORE INSERT ON memory_projection_dependencies WHEN NEW.projection_kind='morning_brief' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect(() => new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toThrow(MorningPublicationError);
    expect(publicationRows(db)).toEqual(before);
  });

  it("rejects a target-key collision instead of silently losing a contributor identity", async () => {
    const { db, claim } = await setup();
    new MemoryProjectionAuthority(db).bind({ kind: "recommendation", id: RECOMMENDATION_ID, component_id: RECOMMENDATION_ID },
      [{ target_digest: SECOND_SOURCE_TARGET, source_identity_digest: `sha256:${"d".repeat(64)}` }], PUBLICATION_AT);
    const before = publicationRows(db);
    expect(() => new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toThrow(MorningPublicationError);
    expect(publicationRows(db)).toEqual(before);
  });

  it("rechecks lease and source expiry before committing", async () => {
    const { db, claim } = await setup();
    for (const elapsed of [300_000, 3_600_000]) {
      let calls = 0; const before = publicationRows(db);
      const publisher = new MorningBriefPublisher(db, () => new Date(PUBLICATION_AT.getTime() + (calls++ === 0 ? 0 : elapsed)));
      expect(() => publisher.publish(claim, 1_048_576)).toThrow(MorningPublicationError);
      expect(publicationRows(db)).toEqual(before);
    }
  });

  it("stores an explicit no-data artifact for an empty source", async () => {
    const { db, claim } = await setup({ empty: true });
    expect(new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576)).toMatchObject({ published: true, source_items: 0 });
    expect(todayProjection(db, PUBLICATION_AT)["brief"]).toMatchObject({ state: "no_data", item_count: 0 });
  });
});
