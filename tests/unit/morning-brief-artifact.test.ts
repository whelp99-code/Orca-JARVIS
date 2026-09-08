import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { generateMorningBrief, parseMorningBriefInput, verifyMorningBriefResult } from "../../src/morning-brief.js";
import { DEFAULT_MORNING_BRIEF_LIMITS } from "../../src/morning-brief-input.js";
import { morningInput, morningRecord } from "../fixtures/morning-brief-record.js";

const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const brief = () => generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord()])));
function rehash(value: any) {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => !["brief_id", "canonical_digest"].includes(key)));
  const canonical_digest = hash(core);
  return { ...core, canonical_digest,
    brief_id: `morning-brief:v2:${hash({ generated_at: value.generated_at, canonical_digest }).slice(7)}` };
}
function rehashItem(value: any) {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => !["provenance_digest", "canonical_digest"].includes(key)));
  const provenance = { contributing_item_ids: value.contributing_item_ids,
    contributing_recommendation_ids: value.contributing_recommendation_ids, contributing_action_ids: value.contributing_action_ids,
    source_ids: value.source_ids, citations: value.citations, observed_at: value.observed_at,
    valid_from: value.valid_from, valid_until: value.valid_until, fresh_until: value.fresh_until };
  return { ...core, canonical_digest: hash(core), provenance_digest: hash(provenance) };
}
const rejects = (value: unknown) => expect(() => verifyMorningBriefResult(value)).toThrow("MORNING_BRIEF_INTEGRITY_FAILURE");

describe("morning brief artifact integrity", () => {
  it("roundtrips generated populated, empty, omitted and bounded sections", () => {
    const inputs = [morningInput([morningRecord()]), morningInput([]),
      { ...morningInput([]), context_readiness: "no_data" },
      { ...morningInput([morningRecord({ state: "stale" })]), context_readiness: "degraded" },
      morningInput([morningRecord({ state: "blocked", owner_decision_required: false })]),
      morningInput([morningRecord({ kind: "information", state: "information", owner_decision_required: false })]),
      { ...morningInput([morningRecord()]), limits: { ...DEFAULT_MORNING_BRIEF_LIMITS, max_total_items: 0 } },
      morningInput([morningRecord({ copy: `${"a".repeat(159)} b` })]),
      ...["available", "missing", "late", "failed", "capped", "incompatible", "stale"].map(state =>
        ({ ...morningInput([morningRecord()]), external_intelligence: { enabled: true, state } })),
    ];
    for (const input of inputs) {
      const generated = generateMorningBrief(parseMorningBriefInput(input));
      expect(verifyMorningBriefResult(JSON.parse(JSON.stringify(generated)))).toEqual(generated);
    }
  });
  it("keeps shared recommendation/source links and merged provenance valid", () => {
    const shared = morningRecord({ item_id: "item-2", action_id: "action-2", semantic_key: "another" });
    const merged = morningRecord({ item_id: "item-3", action_id: "action-3", semantic_key: "review-release" });
    const generated = generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord(), shared, merged])));
    expect(verifyMorningBriefResult(generated)).toEqual(generated);
  });
  it("omits future evidence before merging so a generated brief remains readable", () => {
    const future = morningRecord({ item_id: "future-item", action_id: "future-action", observed_at: "2026-08-28T12:01:00.000Z" });
    const output = generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord(), future])));
    expect(output.omissions).toContainEqual({ reason: "insufficient_citation", count: 1 });
    expect(output.needs_you_first[0]?.contributing_item_ids).toEqual(["item-1"]);
    expect(verifyMorningBriefResult(output)).toEqual(output);
  });
  it("omits cross-section semantic collisions without losing unrelated items", () => {
    const information = morningRecord({ item_id: "a", action_id: "a-action", kind: "information", state: "information",
      owner_decision_required: false });
    const inferred = morningRecord({ item_id: "b", action_id: "b-action", trust: "inferred", owner_decision_required: false });
    const waiting = morningRecord({ item_id: "c", action_id: "c-action", state: "blocked", owner_decision_required: false });
    const unrelated = morningRecord({ item_id: "z", action_id: "z-action", semantic_key: "separate" });
    for (const pair of [[information, inferred], [information, waiting], [inferred, waiting]]) {
      const output = generateMorningBrief(parseMorningBriefInput(morningInput([...pair, unrelated])));
      expect(output.needs_you_first).toHaveLength(1);
      expect(output.needs_you_first[0]?.contributing_item_ids).toEqual(["z"]);
      expect(output.fyi).toEqual([]); expect(output.waiting).toEqual([]);
      expect(output.omissions).toContainEqual({ reason: "conflicting", count: 2 });
      expect(verifyMorningBriefResult(output)).toEqual(output);
      expect(generateMorningBrief(parseMorningBriefInput(morningInput([...pair].reverse().concat(unrelated))))).toEqual(output);
    }
  });
  it("accounts for conflicting deadlines instead of mixing one priority with another deadline", () => {
    const priority = morningRecord().priority;
    const today = morningRecord({ deadline: "2026-08-28T13:00:00.000Z", priority: { ...priority, deadline_bucket: "today" } });
    const overdue = morningRecord({ item_id: "old", action_id: "old-action", owner_decision_required: false,
      deadline: "2026-08-27T13:00:00.000Z", priority: { ...priority, deadline_bucket: "overdue" } });
    const separate = morningRecord({ item_id: "other", action_id: "other-action", semantic_key: "other-task" });
    const output = generateMorningBrief(parseMorningBriefInput(morningInput([today, overdue, separate])));
    expect(verifyMorningBriefResult(output)).toEqual(output);
    expect(output.omissions).toContainEqual({ reason: "conflicting", count: 2 });
    expect(output.needs_you_first.map(item => item.contributing_item_ids)).toEqual([["other"]]);
    expect(generateMorningBrief(parseMorningBriefInput(morningInput([separate, overdue, today])))).toEqual(output);
  });
  it("rejects input identifiers that collide with a generated identity across any source role", () => {
    const outputId = `brief-item:v1:${hash({ semantic_key: "review-release" }).slice(7)}`;
    const records = [
      morningRecord({ item_id: outputId }), morningRecord({ action_id: outputId }),
      morningRecord({ recommendation_id: outputId }),
      morningRecord({ source_ids: [outputId], citations: [{ link_id: "link-1", source_id: outputId, evidence_ref: "evidence-1" }] }),
      morningRecord({ citations: [{ link_id: outputId, source_id: "source-1", evidence_ref: "evidence-1" }] }),
      morningRecord({ item_id: outputId, semantic_key: "another-key" }),
    ];
    for (const record of records) {
      const other = morningRecord({ item_id: "other", action_id: "other-action" });
      expect(() => parseMorningBriefInput(morningInput([record, other]))).toThrow("MORNING_BRIEF_INPUT_INVALID");
    }
  });
  it("keeps derived checksums separate from the input identifier namespace", () => {
    const first = brief().needs_you_first[0]!;
    for (const checksum of [first.canonical_digest, first.provenance_digest]) {
      const other = morningRecord({ item_id: checksum, action_id: "other-action", semantic_key: "other" });
      const output = generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord(), other])));
      expect(output.needs_you_first).toHaveLength(2);
      expect(verifyMorningBriefResult(output)).toEqual(output);
    }
  });
  it("does not permit no-data readiness to hide populated or omitted records", () => {
    expect(() => parseMorningBriefInput({ ...morningInput([morningRecord()]), context_readiness: "no_data" }))
      .toThrow("MORNING_BRIEF_INPUT_INVALID");
    rejects(rehash({ ...brief(), context_readiness: "no_data" }));
    const omitted = generateMorningBrief(parseMorningBriefInput(morningInput([morningRecord({ state: "stale" })])));
    rejects(rehash({ ...omitted, context_readiness: "no_data" }));
  });
  it("rejects hostile object shapes without invoking accessors or proxies", () => {
    let calls = 0;
    const accessor = { ...brief() };
    Object.defineProperty(accessor, "generated_at", { enumerable: true, get() { calls++; return "x"; } });
    const proxy = new Proxy(brief(), { get() { calls++; throw new Error("DO_NOT_INVOKE"); } });
    const sparse = { ...brief(), needs_you_first: new Array(1) };
    const arrayAccessor = [brief().needs_you_first[0]];
    Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { calls++; return {}; } });
    for (const value of [accessor, proxy, sparse, { ...brief(), needs_you_first: arrayAccessor },
      Object.assign(Object.create({}), brief()), { ...brief(), extra: true }, null]) rejects(value);
    expect(calls).toBe(0);
  });
  it("binds FYI, waiting and action section membership into the item digest", () => {
    for (const source of [
      morningRecord({ kind: "information", state: "information", owner_decision_required: false }),
      morningRecord({ state: "blocked", owner_decision_required: false }),
      morningRecord({ owner_decision_required: false, deadline: "2026-08-28T13:00:00.000Z",
        priority: { ...morningRecord().priority, deadline_bucket: "today" } }),
    ]) {
      const generated = generateMorningBrief(parseMorningBriefInput(morningInput([source])));
      const sections = ["needs_you_first", "waiting", "fyi"] as const;
      const from = sections.find(section => generated[section].length > 0)!;
      const item = generated[from][0]!;
      for (const to of sections.filter(section => section !== from)) {
        rejects(rehash({ ...generated, [from]: [], [to]: [item] }));
        rejects(rehash({ ...generated, [from]: [], [to]: [{ ...item,
          reporting_class: to === "needs_you_first" ? "action" : to }] }));
      }
    }
  });
  it("rejects the unbound v1 format rather than inferring a missing reporting class", () => {
    const generated = brief();
    const oldItem = Object.fromEntries(Object.entries(generated.needs_you_first[0]!).filter(([key]) => key !== "reporting_class"));
    const legacy = rehash({ ...generated, schema_version: 1, needs_you_first: [rehashItem(oldItem)] });
    rejects({ ...legacy, brief_id: legacy.brief_id.replace("morning-brief:v2:", "morning-brief:v1:") });
  });
  it.each([
    ["brief identity", (value: any) => ({ ...value, brief_id: "morning-brief:v2:" + "0".repeat(64) })],
    ["top digest", (value: any) => ({ ...value, canonical_digest: "sha256:" + "0".repeat(64) })],
    ["nested digest", (value: any) => rehash({ ...value, needs_you_first: [{ ...value.needs_you_first[0], copy: "Changed" }] })],
    ["missing fields", (value: any) => rehash({ ...value, needs_you_first: [{ copy: "Claim" }] })],
    ["wrong version", (value: any) => rehash({ ...value, schema_version: 3 })],
    ["default limits substitution", (value: any) => rehash({ ...value, limits: null })],
    ["omitted count", (value: any) => rehash({ ...value, omitted_count: 1 })],
    ["empty unaccounted abstention", (value: any) => rehash({ ...value, needs_you_first: [] })],
    ["false abstention", (value: any) => rehash({ ...value, abstention_reasons: ["no_data"] })],
    ["false degradation", (value: any) => rehash({ ...value, degradation_reasons: [] })],
    ["external status", (value: any) => rehash({ ...value, external_intelligence: { enabled: true, skip_reason: "random" } })],
    ["duplicate items", (value: any) => rehash({ ...value, needs_you_first: [value.needs_you_first[0], value.needs_you_first[0]] })],
    ["owner in waiting", (value: any) => rehash({ ...value, needs_you_first: [], waiting: value.needs_you_first })],
    ["invalid timestamp", (value: any) => rehash({ ...value, generated_at: "2026-02-30T12:00:00.000Z" })],
  ])("rejects %s even if the outer digest is recomputed", (_label, mutate) => rejects(mutate(brief())));
  it.each([
    ["untrusted", { trust: "untrusted" }],
    ["foreign representative", { recommendation_id: "another" }],
    ["duplicate source", { source_ids: ["source-1", "source-1"] }],
    ["no source", { source_ids: [], citations: [] }],
    ["missing citation", { citations: [] }],
    ["extra citation", { citations: [{ link_id: "link-1", source_id: "foreign", evidence_ref: "evidence-1" }] }],
    ["future observation", { observed_at: "2026-08-28T12:00:00.001Z" }],
    ["expired", { valid_until: "2026-08-28T12:00:00.000Z" }],
    ["stale", { fresh_until: "2026-08-28T12:00:00.000Z" }],
    ["oversize copy", { copy: "한".repeat(54) }],
    ["private copy", { copy: "token=secret-value" }],
    ["malformed identity", { item_id: "ordinary-text" }],
    ["lost contributor", { contributing_action_ids: [] }],
    ["control character", { copy: "unsafe\ncopy" }],
  ])("rejects rehashed item %s", (_label, fields) => {
    const value = brief();
    rejects(rehash({ ...value, needs_you_first: [rehashItem({ ...value.needs_you_first[0], ...fields })] }));
  });
  it("enforces declared total and section caps independently of the hard maxima", () => {
    const value = brief();
    rejects(rehash({ ...value, limits: { ...value.limits, max_needs_you_first: 0 } }));
    rejects(rehash({ ...value, limits: { ...value.limits, max_total_items: 0 } }));
    const lots = Array.from({ length: 40 }, (_, index) => `source-${index}`);
    const cited = rehashItem({ ...value.needs_you_first[0], source_ids: lots,
      citations: lots.map((source_id, index) => ({ link_id: `link-${index}`, source_id, evidence_ref: `evidence-${index}` })) });
    rejects(rehash({ ...value, needs_you_first: [cited], limits: { ...value.limits, max_total_bytes: 2048 } }));
  });
  it("does not return mutable aliases to the caller's artifact", () => {
    const input: any = brief(); const parsed = verifyMorningBriefResult(input);
    input.needs_you_first[0].citations[0].source_id = "tampered";
    expect(parsed.needs_you_first[0]?.citations[0]?.source_id).toBe("source-1");
  });
});
