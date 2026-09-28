import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, DailyLoopStore, MorningBriefPublisher } from "../../src/index.js";
import { morningPublicationFixture, PUBLICATION_AT } from "../fixtures/morning-publication.js";
import { tempDb } from "../helpers.js";

const MAC_AUTOMATION = "960f1c65-7f57-47e3-88f5-80bc5964ee7e";
const DAY = "2026-08-28";
/** 2026-08-28 06:50, 07:10, and 07:20 Asia/Seoul. */
const AT_0650 = new Date("2026-08-27T21:50:00.000Z");
const AT_0710 = new Date("2026-08-27T22:10:00.000Z");
const AT_0720 = new Date("2026-08-27T22:20:00.000Z");
const FRESH_REFRESH = { schema_version: 1, refresh_id: "refresh-fresh", state: "completed",
  completed_at: AT_0710.toISOString(), protocol_version: 1, capped: false } as const;
const SECTION_KEYS = ["now", "blocked", "decisions", "next_3", "workers", "risks"] as const;

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

async function citedFixture() {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const fixture = await morningPublicationFixture(db);
  return { db, ...fixture };
}

async function morningRun(at: Date) {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await db.migrate();
  const store = new DailyLoopStore(db);
  const run = store.prepare({ due: { kind: "due", local_date: DAY, phase: "morning", scheduled_at: at.toISOString() },
    created_at: at, deadline_at: new Date(at.getTime() + 3_600_000),
    steps: [{ key: "morning_reconcile", sequence: 1 }] });
  const claim = store.claim({ run_id: run, owner_id: "morning-publisher", at, lease_ms: 900_000 });
  return { db, store, claim, run };
}

function count(db: AuthorityDb, table: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function storedBrief(db: AuthorityDb): Record<string, unknown> {
  const row = db.db.prepare("SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile'").get() as
    { detail_json: string } | undefined;
  if (row === undefined) return {};
  return JSON.parse(row.detail_json) as Record<string, unknown>;
}

describe("cited morning operating brief", () => {
  it("caps cited actions at three and emits the operating sections when the publisher is given no action cap", async () => {
    const { db, claim } = await citedFixture();
    const recommendations = count(db, "personal_recommendations");
    const workflows = count(db, "workflow_runs");
    const commands = count(db, "control_command_requests");
    const result = new MorningBriefPublisher(db, () => PUBLICATION_AT).publish(claim, 1_048_576);
    const brief = storedBrief(db);
    const items = ["needs_you_first", "waiting", "fyi"].flatMap(key => {
      const value = brief[key];
      return Array.isArray(value) ? value : [];
    });
    expect(result.source_items).toBeLessThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(result).toMatchObject({ published: true, operations: { sections: {
      now: expect.anything(), blocked: expect.anything(), decisions: expect.anything(),
      next_3: expect.anything(), workers: expect.anything(), risks: expect.anything(),
    } } });
    for (const key of SECTION_KEYS) expect(result).toHaveProperty(`operations.sections.${key}`);
    expect(count(db, "personal_recommendations")).toBe(recommendations);
    expect(count(db, "notification_intents")).toBe(1);
    expect(count(db, "workflow_runs")).toBe(workflows);
    expect(count(db, "control_command_requests")).toBe(commands);
    expect(JSON.stringify(brief)).not.toContain(MAC_AUTOMATION);
    expect(JSON.stringify(result)).not.toContain(MAC_AUTOMATION);
  });

  it("holds publication until 07:20 when the refresh has not completed", async () => {
    const { db, claim } = await morningRun(AT_0710);
    const result = new MorningBriefPublisher(db, () => AT_0710, { subscribedAt: AT_0710 }).publish(claim, 1_048_576);
    expect(result).toMatchObject({ published: false, held: true });
    expect(db.db.prepare("SELECT state FROM daily_loop_steps").get()).toEqual({ state: "pending" });
  });

  it("assembles before 07:20 only after a subscription installed before the 07:00 refresh", async () => {
    const { db, claim } = await morningRun(AT_0710);
    const result = new MorningBriefPublisher(db, () => AT_0710, { subscribedAt: AT_0650 })
      .publish(claim, 1_048_576, undefined, FRESH_REFRESH);
    expect(result).toMatchObject({ published: true, held: false, operations: { refresh_subscription: "before_07:00" } });
    expect(JSON.stringify(result)).not.toContain(MAC_AUTOMATION);
  });

  it.each([
    ["no_data", null],
    ["failed", { schema_version: 1, refresh_id: "refresh-failed", state: "failed", completed_at: AT_0720.toISOString(),
      protocol_version: 1, capped: false }],
    ["capped", { schema_version: 1, refresh_id: "refresh-capped", state: "completed", completed_at: AT_0720.toISOString(),
      protocol_version: 1, capped: true }],
    ["previous_date", { schema_version: 1, refresh_id: "refresh-yesterday", state: "completed",
      completed_at: "2026-08-26T22:05:00.000Z", protocol_version: 1, capped: false }],
  ] as const)("emits an honest degraded brief at 07:20 when refresh is %s", async (reason, refresh) => {
    const { db, claim } = await morningRun(AT_0710);
    const result = new MorningBriefPublisher(db, () => AT_0720).publish(claim, 1_048_576, undefined, refresh);
    const brief = storedBrief(db);
    expect(result.published).toBe(true);
    expect(brief["context_readiness"]).not.toBe("ready");
    expect(JSON.stringify(result)).toContain(reason === "no_data" ? "no_data" : reason === "failed" ? "refresh_failed"
      : reason === "capped" ? "refresh_capped" : "previous");
    expect(brief["needs_you_first"]).toEqual([]);
    expect(JSON.stringify(brief)).not.toContain(MAC_AUTOMATION);
    expect(count(db, "workflow_runs")).toBe(0);
  });

  it("yields the same operating digest for identical inputs", async () => {
    const left = await citedFixture();
    const right = await citedFixture();
    const a = new MorningBriefPublisher(left.db, () => PUBLICATION_AT).publish(left.claim, 1_048_576);
    const b = new MorningBriefPublisher(right.db, () => PUBLICATION_AT).publish(right.claim, 1_048_576);
    expect(a).toHaveProperty("operations.canonical_digest");
    expect(a).toMatchObject({ operations: { canonical_digest: (b as { operations?: { canonical_digest?: string } }).operations?.canonical_digest } });
    expect(storedBrief(left.db)["canonical_digest"]).toBe(storedBrief(right.db)["canonical_digest"]);
  });
});
