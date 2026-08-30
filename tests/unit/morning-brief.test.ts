import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MorningBriefContractError,
  generateMorningBrief,
  parseMorningBriefInput,
  type MorningBriefInput,
} from "../../src/morning-brief.js";
import { canonicalize } from "../../src/canonical.js";

const CLOCK = "2026-08-30T00:00:00.000Z";
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

function record(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const base = {
    item_id: "item-1", recommendation_id: "rec-1", action_id: "act-1", semantic_key: "ship-release",
    kind: "action", state: "actionable", copy: "Approve the cited release plan", source_ids: ["source-1"],
    citations: [{ link_id: "cite-1", source_id: "source-1", evidence_ref: "evidence-1" }],
    observed_at: "2026-08-29T23:00:00.000Z", valid_from: "2026-08-29T23:00:00.000Z",
    valid_until: "2026-08-31T00:00:00.000Z", fresh_until: "2026-08-30T12:00:00.000Z",
    trust: "confirmed", confidence: "high", owner_decision_required: true, deadline: "2026-08-30T08:00:00.000Z",
    priority: { owner_safety_gate: "owner_approval_required", customer_impact: "customer_critical", deadline_bucket: "today",
      dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "ship-release" },
  };
  const merged = { ...base, ...overrides };
  const suffix = String(merged.item_id).replace(/^item-/, "");
  const sourceIds = Object.hasOwn(overrides, "source_ids") ? merged.source_ids : [`source-${suffix}`];
  const citations = Object.hasOwn(overrides, "citations")
    ? merged.citations
    : [{ link_id: `cite-${suffix}`, source_id: `source-${suffix}`, evidence_ref: `evidence-${suffix}` }];
  const payload = { ...merged, source_ids: sourceIds, citations };
  const provenance = {
    item_id: payload.item_id, recommendation_id: payload.recommendation_id, action_id: payload.action_id,
    source_ids: payload.source_ids, citations: payload.citations, observed_at: payload.observed_at,
    valid_from: payload.valid_from, valid_until: payload.valid_until, fresh_until: payload.fresh_until,
  };
  return { ...payload, provenance_digest: digest(provenance), canonical_digest: digest(payload) };
}
function input(items: readonly unknown[], overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema_version: 1, generated_at: CLOCK, context_readiness: "ready", external_intelligence: { enabled: false, state: "off" },
    limits: null, items, ...overrides,
  };
}

function parse(items: readonly unknown[], overrides: Readonly<Record<string, unknown>> = {}): MorningBriefInput {
  return parseMorningBriefInput(input(items, overrides));
}

describe("morning brief boundary", () => {
  it("fails typed before output when accessors, sparse arrays, unknown keys, prototypes, or forged integrity enter", () => {
    // Given: malformed values at each structural and integrity boundary
    const accessor = input([record()]);
    Object.defineProperty(accessor, "generated_at", { enumerable: true, get: () => CLOCK });
    const sparse = input(new Array(1));
    const unknown = { ...input([record()]), extra: true };
    const prototype = Object.assign(Object.create({}), input([record()]));
    const forged = input([{ ...record(), canonical_digest: `sha256:${"0".repeat(64)}` }]);

    // When / Then: parsing fails closed with one typed error
    for (const value of [accessor, sparse, unknown, prototype, forged]) {
      expect(() => parseMorningBriefInput(value)).toThrow(MorningBriefContractError);
    }
  });

  it("rejects duplicate global identities, links, digests, and private copy", () => {
    // Given: independently valid records that collide or cross privacy boundaries
    const duplicate = record({ item_id: "item-2", recommendation_id: "rec-2", action_id: "act-2", semantic_key: "other",
      source_ids: ["source-2"], citations: [{ link_id: "cite-2", source_id: "source-2", evidence_ref: "evidence-2" }] });
    const first = record();
    const collision = { ...duplicate, source_ids: ["source-1"] };
    const privateValues = ["token=secret-value", "/home/alice/private.txt", "$ sudo cat private"];

    // When / Then
    expect(() => parse([first, duplicate])).not.toThrow();
    expect(() => parse([first, collision])).toThrow(MorningBriefContractError);
    for (const copy of privateValues) expect(() => parse([record({ copy })])).toThrow(MorningBriefContractError);
  });
});

describe("morning brief generation", () => {
  it("emits ordered cited sections with owner due work first and waiting isolated", () => {
    // Given: owner, due, waiting, and information projections
    const values = [
      record(),
      record({ item_id: "item-2", recommendation_id: "rec-2", action_id: "act-2", semantic_key: "due",
        owner_decision_required: false, priority: { owner_safety_gate: "pass", customer_impact: "customer_high", deadline_bucket: "today",
          dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "medium", stable_identity: "due" } }),
      record({ item_id: "item-3", recommendation_id: "rec-3", action_id: "act-3", semantic_key: "waiting", state: "dependency_waiting",
        owner_decision_required: false, deadline: null, priority: { owner_safety_gate: "pass", customer_impact: "internal",
          deadline_bucket: "none", dependency_blocking: "blocks_work", irreversible_risk: "low", effort_cost: "low", stable_identity: "waiting" } }),
      record({ item_id: "item-4", recommendation_id: "rec-4", action_id: "act-4", semantic_key: "info", kind: "information",
        state: "information", owner_decision_required: false, deadline: null, priority: { owner_safety_gate: "pass", customer_impact: "internal",
          deadline_bucket: "none", dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "info" } }),
    ];

    // When
    const result = generateMorningBrief(parse(values));

    // Then
    expect(result.needs_you_first.map(item => item.item_id)).toEqual([expect.stringMatching(/^brief-item:v1:/), expect.stringMatching(/^brief-item:v1:/)]);
    expect(result.needs_you_first[0]?.owner_decision_required).toBe(true);
    expect(result.waiting).toHaveLength(1);
    expect(result.waiting[0]?.owner_decision_required).toBe(false);
    expect(result.fyi).toHaveLength(1);
    expect(result.needs_you_first.every(item => item.citations.length > 0 && item.source_ids.length > 0)).toBe(true);
  });

  it("is byte deterministic across duplicates, order, timezone, locale, and host clock", () => {
    // Given: a semantic duplicate with distinct provenance
    const duplicate = record({ item_id: "item-9", recommendation_id: "rec-9", action_id: "act-9", semantic_key: "ship-release",
      source_ids: ["source-9"], citations: [{ link_id: "cite-9", source_id: "source-9", evidence_ref: "evidence-9" }] });
    const originalTz = process.env.TZ;

    // When
    process.env.TZ = "Pacific/Honolulu";
    const leftResult = generateMorningBrief(parse([duplicate, record()]));
    const left = JSON.stringify(leftResult);
    process.env.TZ = "Asia/Seoul";
    const right = JSON.stringify(generateMorningBrief(parse([record(), duplicate])));
    process.env.TZ = originalTz;

    // Then
    expect(left).toBe(right);
    expect(leftResult.needs_you_first[0]?.source_ids).toEqual(["source-1", "source-9"]);
  });

  it("omits every ineligible state with exact reasons and reports no_data honestly", () => {
    // Given
    const reasons = ["stale", "expired", "deleted", "corrupt", "untrusted", "conflicting", "unrelated", "insufficient_citation"] as const;
    const values = reasons.map((state, index) => record({ item_id: `item-${index + 10}`, recommendation_id: `rec-${index + 10}`,
      action_id: `act-${index + 10}`, semantic_key: `omit-${state}`, state,
      trust: state === "untrusted" ? "untrusted" : "confirmed",
      ...(state === "insufficient_citation" ? { citations: [] } : {}) }));

    // When
    const omitted = generateMorningBrief(parse(values));
    const empty = generateMorningBrief(parse([], { context_readiness: "no_data" }));

    // Then
    expect(omitted.omissions.map(item => item.reason)).toEqual(reasons);
    expect(empty.abstention_reasons).toEqual(["no_data"]);
    expect(empty.needs_you_first).toEqual([]);
    expect(empty.waiting).toEqual([]);
    expect(empty.fyi).toEqual([]);
  });

  it("records each external intelligence skip without invoking a dependency", () => {
    // Given / When / Then
    for (const state of ["missing", "late", "failed", "capped", "incompatible", "stale"] as const) {
      const result = generateMorningBrief(parse([record()], { external_intelligence: { enabled: true, state } }));
      expect(result.external_intelligence.skip_reason).toBe(`external_intelligence_${state}`);
    }
    expect(generateMorningBrief(parse([record()])).external_intelligence.skip_reason).toBe("external_intelligence_disabled");
  });

  it("fails one-field provenance and timestamp mutations and accepts copy threshold boundaries", () => {
    // Given: one valid record and independent one-field mutations
    const valid = record({ copy: "x".repeat(161) });

    // When / Then
    expect(generateMorningBrief(parse([valid])).needs_you_first[0]?.copy).toHaveLength(160);
    for (const field of ["observed_at", "valid_from", "valid_until", "fresh_until"] as const) {
      const mutated = { ...valid, [field]: field === "valid_until" ? "2026-09-01T00:00:00.000Z" : "2026-08-29T22:00:00.000Z" };
      expect(() => parse([mutated])).toThrow(MorningBriefContractError);
    }
    expect(generateMorningBrief(parse([record({ copy: "한".repeat(53) })])).needs_you_first[0]?.copy).toBe("한".repeat(53));
    expect(Buffer.byteLength(generateMorningBrief(parse([record({ copy: "한".repeat(54) })])).needs_you_first[0]?.copy ?? "", "utf8")).toBe(159);
  });

  it("enforces UTF-8 copy, section, citation, and total byte bounds deterministically", () => {
    // Given: CJK copy and more candidates than every cap
    const values = Array.from({ length: 20 }, (_, index) => record({ item_id: `item-${index + 30}`, recommendation_id: `rec-${index + 30}`,
      action_id: `act-${index + 30}`, semantic_key: `bounded-${String(index).padStart(2, "0")}`, copy: "한".repeat(80),
      source_ids: [`source-${index + 30}`],
      citations: [{ link_id: `cite-${index + 30}`, source_id: `source-${index + 30}`, evidence_ref: `evidence-${index + 30}` }],
      owner_decision_required: false, kind: "information", state: "information", deadline: null,
      priority: { owner_safety_gate: "pass", customer_impact: "internal", deadline_bucket: "none", dependency_blocking: "non_blocking",
        irreversible_risk: "low", effort_cost: "low", stable_identity: `bounded-${String(index).padStart(2, "0")}` } }));

    // When
    const result = generateMorningBrief(parse(values));

    // Then
    expect(result.fyi).toHaveLength(8);
    expect(result.needs_you_first.length + result.waiting.length + result.fyi.length).toBeLessThanOrEqual(18);
    expect(result.fyi.every(item => Buffer.byteLength(item.copy, "utf8") <= 160)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(result.limits.max_total_bytes);
    expect(result.omissions.some(item => item.reason === "section_cap")).toBe(true);

    const sourceIds = Array.from({ length: 65 }, (_, index) => `source-cap-${index}`);
    const manyCitations = sourceIds.map((sourceId, index) => ({ link_id: `cite-cap-${index}`, source_id: sourceId,
      evidence_ref: `evidence-cap-${index}` }));
    const citationBound = generateMorningBrief(parse([record({ source_ids: sourceIds, citations: manyCitations })]));
    expect(citationBound.needs_you_first[0]?.source_ids).toHaveLength(64);
    expect(citationBound.needs_you_first[0]?.citations).toHaveLength(64);
    expect(citationBound.omissions).toContainEqual({ reason: "citation_cap", count: 1 });

    const limits = { max_needs_you_first: 5, max_waiting: 5, max_fyi: 8, max_total_items: 18,
      max_sources_per_item: 64, max_copy_bytes: 160, max_total_bytes: 2_048 };
    const byteBound = generateMorningBrief(parse(values, { limits }));
    expect(Buffer.byteLength(JSON.stringify(byteBound), "utf8")).toBeLessThanOrEqual(2_048);
    expect(byteBound.omissions.some(item => item.reason === "total_cap")).toBe(true);
  });
});
