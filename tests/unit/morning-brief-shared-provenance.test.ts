import { describe, expect, it } from "vitest";
import { generateMorningBrief, parseMorningBriefInput } from "../../src/morning-brief.js";
import { morningInput, morningRecord } from "../fixtures/morning-brief-record.js";

const second = (overrides: Parameters<typeof morningRecord>[0] = {}) => morningRecord({
  item_id: "item-2", action_id: "action-2", semantic_key: "review-document", ...overrides,
});
const parse = (items: ReturnType<typeof morningRecord>[]) => parseMorningBriefInput(morningInput(items));

describe("morning brief shared provenance", () => {
  it("keeps two actions from one recommendation with their shared source and citation", () => {
    const records = [morningRecord(), second()];
    const result = generateMorningBrief(parse(records));
    expect(result.needs_you_first).toHaveLength(2);
    expect(result.needs_you_first.map(item => item.recommendation_id)).toEqual(["rec-1", "rec-1"]);
    for (const item of result.needs_you_first) {
      expect(item.source_ids).toEqual(["source-1"]);
      expect(item.citations).toEqual(records[0]?.citations);
    }
    expect(generateMorningBrief(parse([...records].reverse()))).toEqual(result);
  });

  it("deduplicates exact citations when semantic records merge without spending citation budget twice", () => {
    const first = morningRecord();
    const raw = morningInput([first, second({ semantic_key: first.semantic_key, recommendation_id: "rec-2" })]);
    const parsed = parseMorningBriefInput(raw);
    const result = generateMorningBrief({ ...parsed, limits: { ...parsed.limits, max_sources_per_item: 1 } });
    expect(result.needs_you_first).toHaveLength(1);
    expect(result.needs_you_first[0]?.contributing_recommendation_ids).toEqual(["rec-1", "rec-2"]);
    expect(result.needs_you_first[0]?.contributing_action_ids).toEqual(["action-1", "action-2"]);
    expect(result.needs_you_first[0]?.citations).toEqual(first.citations);
    expect(result.omissions).toEqual([]);
  });

  it("keeps distinct citations to the same source and accounts only for unique omitted links", () => {
    const first = morningRecord();
    const extra = { link_id: "link-2", source_id: "source-1", evidence_ref: "evidence-2" };
    const parsed = parse([first, second({ semantic_key: first.semantic_key, citations: [...first.citations, extra] })]);
    expect(generateMorningBrief(parsed).needs_you_first[0]?.citations).toEqual([...first.citations, extra]);
    const capped = generateMorningBrief({ ...parsed, limits: { ...parsed.limits, max_sources_per_item: 1 } });
    expect(capped.needs_you_first[0]?.citations).toEqual(first.citations);
    expect(capped.omissions).toEqual([{ reason: "citation_cap", count: 1 }]);
  });

  it("does not let repeated extra links displace another distinct citation at the cap", () => {
    const first = morningRecord();
    const extra = { link_id: "link-2", source_id: "source-1", evidence_ref: "evidence-2" };
    const last = { link_id: "link-3", source_id: "source-1", evidence_ref: "evidence-3" };
    const records = [morningRecord({ citations: [...first.citations, extra] }), second({
      semantic_key: first.semantic_key, citations: [...first.citations, extra, last],
    })];
    const parsed = parse(records);
    const result = generateMorningBrief({ ...parsed, limits: { ...parsed.limits, max_sources_per_item: 3 } });
    expect(result.needs_you_first[0]?.citations).toEqual([...first.citations, extra, last]);
    expect(result.omissions).toEqual([]);
    const reversed = parse([...records].reverse());
    expect(generateMorningBrief({ ...reversed, limits: { ...reversed.limits, max_sources_per_item: 3 } })).toEqual(result);
  });

  it.each(["source", "evidence"] as const)("rejects one link ID reused with different %s", field => {
    const changed = second({ source_ids: field === "source" ? ["source-2"] : ["source-1"], citations: [{
      link_id: "link-1", source_id: field === "source" ? "source-2" : "source-1",
      evidence_ref: field === "evidence" ? "evidence-2" : "evidence-1",
    }] });
    for (const records of [[morningRecord(), changed], [changed, morningRecord()]]) {
      expect(() => parse(records)).toThrow("MORNING_BRIEF_INPUT_INVALID");
    }
  });

  it("rejects duplicate entities, repeated links within one record, and cross-role identity collisions", () => {
    const first = morningRecord();
    for (const changed of [second({ item_id: first.item_id }), second({ action_id: first.action_id }),
      second({ recommendation_id: first.action_id }), second({ source_ids: [first.item_id],
        citations: [{ link_id: "link-2", source_id: first.item_id, evidence_ref: "evidence-1" }] }),
      second({ citations: [...first.citations, ...first.citations] })]) {
      expect(() => parse([first, changed])).toThrow("MORNING_BRIEF_INPUT_INVALID");
    }
    expect(() => parse([first, { ...second(), canonical_digest: first.canonical_digest }]))
      .toThrow("MORNING_BRIEF_INPUT_INVALID");
  });
});
