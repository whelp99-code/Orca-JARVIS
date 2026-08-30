import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { MorningBriefContractError, generateMorningBrief, parseMorningBriefInput } from "../../src/morning-brief.js";

const CLOCK = "2026-08-30T00:00:00.000Z";
class MorningBriefTestFixtureError extends Error {
  readonly name = "MorningBriefTestFixtureError";
}
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function signed(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const base = {
    item_id: "item-1", recommendation_id: "rec-1", action_id: "action-1", semantic_key: "semantic-1", kind: "action",
    state: "actionable", copy: "Approve cited action", source_ids: ["source-1"],
    citations: [{ link_id: "link-1", source_id: "source-1", evidence_ref: "evidence-1" }],
    observed_at: "2026-08-29T23:00:00.000Z", valid_from: "2026-08-29T23:00:00.000Z",
    valid_until: "2026-08-31T00:00:00.000Z", fresh_until: "2026-08-30T12:00:00.000Z", trust: "confirmed",
    confidence: "high", owner_decision_required: true, deadline: "2026-08-30T08:00:00.000Z",
    priority: { owner_safety_gate: "owner_approval_required", customer_impact: "customer_critical", deadline_bucket: "today",
      dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "semantic-1" },
  };
  const payload = { ...base, ...overrides };
  const provenance = { item_id: payload.item_id, recommendation_id: payload.recommendation_id, action_id: payload.action_id,
    source_ids: payload.source_ids, citations: payload.citations, observed_at: payload.observed_at, valid_from: payload.valid_from,
    valid_until: payload.valid_until, fresh_until: payload.fresh_until };
  return { ...payload, provenance_digest: digest(provenance), canonical_digest: digest(payload) };
}
function raw(items: readonly unknown[], overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { schema_version: 1, generated_at: CLOCK, context_readiness: "ready",
    external_intelligence: { enabled: false, state: "off" }, limits: null, items, ...overrides };
}
function trapped<T extends object>(value: T, invoked: { count: number }): T {
  const trap = (): never => { invoked.count += 1; throw new MorningBriefTestFixtureError("HOSTILE_PROXY_TRAP_INVOKED"); };
  return new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
}

describe("morning brief remediation boundary", () => {
  it("rejects proxies at every nested object and array boundary without invoking traps", () => {
    // Given: one hostile proxy at each parser boundary
    const invoked = { count: 0 };
    const baseRecord = signed();
    const priority = baseRecord["priority"];
    const citations = baseRecord["citations"];
    if (typeof priority !== "object" || priority === null || !Array.isArray(citations)) {
      throw new MorningBriefTestFixtureError("INVALID_TEST_FIXTURE");
    }
    const cases = [
      trapped(raw([baseRecord]), invoked),
      raw(trapped([baseRecord], invoked)),
      raw([trapped(baseRecord, invoked)]),
      raw([{ ...baseRecord, source_ids: trapped(["source-1"], invoked) }]),
      raw([{ ...baseRecord, citations: trapped(citations, invoked) }]),
      raw([{ ...baseRecord, citations: [trapped({ link_id: "link-1", source_id: "source-1", evidence_ref: "evidence-1" }, invoked)] }]),
      raw([{ ...baseRecord, priority: trapped(priority, invoked) }]),
      { ...raw([baseRecord]), external_intelligence: trapped({ enabled: false, state: "off" }, invoked) },
    ];

    // When / Then
    for (const [index, value] of cases.entries()) {
      expect(() => parseMorningBriefInput(value), `proxy boundary ${index}`).toThrow(MorningBriefContractError);
    }
    expect(invoked.count).toBe(0);
  });

  it("rejects unpaired surrogates in every open string class while preserving valid emoji and CJK", () => {
    // Given
    const unsafe = "unsafe\ud800value";
    const cases = [
      { item_id: unsafe }, { recommendation_id: unsafe }, { action_id: unsafe }, { semantic_key: unsafe }, { copy: unsafe },
      { source_ids: [unsafe], citations: [{ link_id: "link-1", source_id: unsafe, evidence_ref: "evidence-1" }] },
      { citations: [{ link_id: unsafe, source_id: "source-1", evidence_ref: "evidence-1" }] },
      { citations: [{ link_id: "link-1", source_id: "source-1", evidence_ref: unsafe }] },
    ];

    // When / Then
    for (const overrides of cases) expect(() => parseMorningBriefInput(raw([signed(overrides)]))).toThrow(MorningBriefContractError);
    const valid = parseMorningBriefInput(raw([signed({ copy: "확인 😀 완료" })]));
    expect(generateMorningBrief(valid).needs_you_first[0]?.copy).toBe("확인 😀 완료");
  });

  it("omits incomplete citation coverage and emits only bidirectionally covered semantic provenance", () => {
    // Given: one partial record and two completely covered semantic contributors
    const partial = signed({ source_ids: ["source-1", "source-2"] });
    const contributor = signed({ item_id: "item-2", recommendation_id: "rec-2", action_id: "action-2",
      source_ids: ["source-2"], citations: [{ link_id: "link-2", source_id: "source-2", evidence_ref: "evidence-2" }] });

    // When
    const omitted = generateMorningBrief(parseMorningBriefInput(raw([partial])));
    const merged = generateMorningBrief(parseMorningBriefInput(raw([signed(), contributor]))).needs_you_first[0];

    // Then
    expect(omitted.omissions).toContainEqual({ reason: "insufficient_citation", count: 1 });
    expect(merged?.source_ids).toEqual(["source-1", "source-2"]);
    expect(new Set(merged?.citations.map(citation => citation.source_id))).toEqual(new Set(merged?.source_ids));
  });

  it("enforces the waiting, needs-you-first, and FYI contradiction matrix", () => {
    // Given
    const waitingOwner = signed({ state: "dependency_waiting", deadline: null });
    const dueWithoutDeadline = signed({ owner_decision_required: false, deadline: null,
      priority: { owner_safety_gate: "pass", customer_impact: "customer_high", deadline_bucket: "today",
        dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "semantic-1" } });
    const dueWrongDate = signed({ owner_decision_required: false, deadline: "2026-08-31T08:00:00.000Z",
      priority: { owner_safety_gate: "pass", customer_impact: "customer_high", deadline_bucket: "today",
        dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "semantic-1" } });
    const inferredFyi = signed({ kind: "information", state: "information", owner_decision_required: false, deadline: null, trust: "inferred",
      priority: { owner_safety_gate: "pass", customer_impact: "internal", deadline_bucket: "none",
        dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "semantic-1" } });

    // When / Then
    for (const value of [waitingOwner, dueWithoutDeadline, dueWrongDate]) {
      expect(() => parseMorningBriefInput(raw([value]))).toThrow(MorningBriefContractError);
    }
    const result = generateMorningBrief(parseMorningBriefInput(raw([inferredFyi])));
    expect(result.fyi).toEqual([]);
    expect(result.omissions).toContainEqual({ reason: "untrusted", count: 1 });
  });

  it("rejects sensitive bytes in every emitted metadata class and leaves serialized output sentinel-free", () => {
    // Given
    const sentinel = "token=task21-secret";
    const cases = [
      { item_id: sentinel }, { recommendation_id: sentinel }, { action_id: sentinel }, { semantic_key: sentinel }, { copy: sentinel },
      { source_ids: [sentinel], citations: [{ link_id: "link-1", source_id: sentinel, evidence_ref: "evidence-1" }] },
      { citations: [{ link_id: sentinel, source_id: "source-1", evidence_ref: "evidence-1" }] },
      { citations: [{ link_id: "link-1", source_id: "source-1", evidence_ref: "/home/owner/private" }] },
    ];

    // When / Then
    for (const overrides of cases) expect(() => parseMorningBriefInput(raw([signed(overrides)]))).toThrow(MorningBriefContractError);
    const serialized = JSON.stringify(generateMorningBrief(parseMorningBriefInput(raw([signed()]))));
    expect(serialized.includes("task21-secret") || serialized.includes("/home/owner") || serialized.includes("\u001b[")).toBe(false);
  });
});
