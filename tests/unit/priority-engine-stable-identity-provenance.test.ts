import { describe, expect, it } from "vitest";
import { rankPriorityActions } from "../../src/index.js";
import { priorityLexicographicCandidates } from "../fixtures/priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "../fixtures/priority-engine-input.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("priority remediation record required");
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("priority remediation records required");
  const output: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw new TypeError("priority remediation record item required");
    output.push(item);
  }
  return output;
}
function stableTieInput(
  leftRef: string | null,
  rightRef: string | null,
  duplicateKeys = false,
): Readonly<Record<string, unknown>> {
  const input = structuredClone(priorityEngineInput({ candidates: priorityLexicographicCandidates("stable_identity") }));
  const candidates = records(input["candidates"]);
  const left = candidates[0];
  const right = candidates[1];
  if (left === undefined || right === undefined) throw new TypeError("priority tie candidates required");
  left["stable_identity"] = { key: duplicateKeys ? "identity-same" : "identity-b", evidence_ref: leftRef };
  right["stable_identity"] = { key: duplicateKeys ? "identity-same" : "identity-a", evidence_ref: rightRef };
  return input;
}
function staleStableTieInput(): Readonly<Record<string, unknown>> {
  const input = structuredClone(stableTieInput("live:stale-a", "live:stale-b"));
  const context = record(input["context_policy_input"]);
  const evidence = records(context["evidence"]);
  const staleFact = (ref: string): Readonly<Record<string, unknown>> => ({
    kind: "evidence",
    ref,
    evidence_class: "linux_live_fact",
    source_host: "linux-control-plane",
    state: "stale",
    trust: "user_confirmed",
    relation: "supports",
    relates_to: null,
    observed_at: "2026-08-28T11:30:00.000Z",
    valid_from: "2026-08-28T11:00:00.000Z",
    valid_until: "2026-08-28T18:00:00.000Z",
    fresh_until: "2026-08-28T12:30:00.000Z",
  });
  context["evidence"] = [...evidence, staleFact("live:stale-a"), staleFact("live:stale-b")];
  return input;
}

describe("Task 17 remediation stable identity provenance", () => {
  it("resolves a tie with selected fresh Linux live evidence", () => {
    // Given: distinct stable keys cite Task 16-selected Linux live facts.
    const input = priorityEngineInput({ candidates: priorityLexicographicCandidates("stable_identity"), reverse: true });
    // When: the exact tie reaches the stable identity field.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: the cited stable identity resolves deterministically and remains visible.
    expect(result.status).toBe("ranked");
    expect(result.actions.map(action => [action.action_id, action.rank])).toEqual([
      ["action-z", 1],
      ["action-a", 2],
    ]);
    expect(result.actions.map(action => action.rationale.citations.stable_identity_evidence_ref)).toEqual([
      "live:customer",
      "live:worker",
    ]);
  });

  it.each([
    ["model/mac", stableTieInput("model:identity:a", "mac:file:identity:b")],
    ["unselected", stableTieInput("linux:absent:a", "linux:absent:b")],
    ["wrong class", stableTieInput("decision:owner:import", "decision:owner:import")],
    ["null", stableTieInput(null, null)],
    ["stale", staleStableTieInput()],
  ] as const)("abstains for %s stable identity evidence", (_name, input) => {
    // Given: exact-tie identity provenance is not a distinct selected fresh Linux live fact.
    // When: stable identity evidence is evaluated.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: both candidates abstain with the tie code and expose no trusted stable citation.
    expect(result.status).toBe("abstained");
    expect(result.reason_codes).toContain("PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE");
    expect(result.actions.every(action => action.reason_codes.includes("PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE"))).toBe(true);
    expect(result.actions.every(action => action.rationale.citations.stable_identity_evidence_ref === null)).toBe(true);
  });

  it("abstains for duplicate stable keys with otherwise selected Linux evidence", () => {
    // Given: two exact-tie candidates share one stable key but cite selected Linux live facts.
    const input = stableTieInput("live:customer", "live:worker", true);
    // When: the duplicate identity is evaluated.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: identity remains unresolved without misclassifying its evidence provenance.
    expect(result.status).toBe("abstained");
    expect(result.actions.every(action => action.reason_codes.includes("PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE"))).toBe(true);
    expect(result.actions.map(action => action.rationale.citations.stable_identity_evidence_ref).sort()).toEqual([
      "live:customer",
      "live:worker",
    ]);
  });
});
