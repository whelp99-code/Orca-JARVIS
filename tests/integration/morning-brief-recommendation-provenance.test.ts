import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { generateMorningBrief, parseMorningBriefInput } from "../../src/morning-brief.js";
import { morningRecommendationProvenance } from "../fixtures/morning-recommendation-provenance.js";
import { tempDb } from "../helpers.js";

it("accepts real stored recommendation identities and evidence shared by three ranked actions", async () => {
  const db = new AuthorityDb(tempDb());
  try {
    await db.migrate();
    const { projection, input } = await morningRecommendationProvenance(db);
    expect(projection.next_actions).toHaveLength(3);
    expect(new Set(input.items.map(item => item.recommendation_id)).size).toBe(1);
    // Two sources stand behind these citations now: the live adapter that produced the observed
    // facts, and the Second Brain the confirmed principle came from.
    expect(new Set(input.items.flatMap(item => item.source_ids)).size).toBe(2);
    const allLinks = input.items.flatMap(item => item.citations.map(link => link.link_id));
    expect(new Set(allLinks).size).toBeLessThan(allLinks.length);
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    const parsed = parseMorningBriefInput(input);
    expect(parsed.items.map(item => item.action_id)).toEqual(input.items.map(item => item.action_id));
    expect(parsed.items.map(item => item.citations)).toEqual(input.items.map(item => item.citations));
    const brief = generateMorningBrief(parsed);
    expect(brief.needs_you_first.map(item => item.copy)).toEqual(["Next: owner-gated-deploy"]);
    expect(brief.needs_you_first[0]?.citations).toEqual(expect.arrayContaining([...(input.items[2]?.citations ?? [])]));
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
});
