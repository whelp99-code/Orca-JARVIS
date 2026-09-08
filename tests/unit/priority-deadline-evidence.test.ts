import { describe, expect, it } from "vitest";
import { canonicalize, rankPriorityActions, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { parsePriorityEngineResult } from "../../src/priority-result-parser.js";
import { defaultPriorityCandidates } from "../fixtures/priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "../fixtures/priority-engine-input.js";

function input(dueAt = "2026-08-28T13:00:00.000Z") {
  const candidates = defaultPriorityCandidates().filter(item => item["action_id"] === "customer-delivery");
  const candidate = candidates[0]!;
  candidate["deadline"] = { ...(candidate["deadline"] as object), due_at: dueAt };
  return priorityEngineInput({ candidates });
}
const generate = () => rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), input());

describe("priority deadline evidence v2", () => {
  it("preserves exact deadlines that v1 maps to an identical ranking", () => {
    const first = input(); const second = input("2026-08-28T14:00:00.000Z");
    expect(rankPriorityActions(priorityPolicyConfig(), first)).toEqual(rankPriorityActions(priorityPolicyConfig(), second));
    const left = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), first);
    const right = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), second);
    expect(left.status).toBe("ranked"); expect(left.schema_version).toBe(2);
    expect(left.deadline_evidence[0]).toEqual({ action_id: "customer-delivery", deadline: {
      due_at: "2026-08-28T13:00:00.000Z", evidence_ref: "live:customer",
      observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
    } });
    expect(canonicalize(left)).not.toEqual(canonicalize(right));
    expect(parsePriorityEngineResult(JSON.parse(JSON.stringify(left)))).toEqual(left);
    expect(parsePriorityEngineResult(JSON.parse(JSON.stringify(right)))).toEqual(right);
  });
  it("retains null deadlines and abstained deadline evidence without changing ranking decisions", () => {
    for (const raw of [priorityEngineInput(), input()]) {
      const legacy = rankPriorityActions(priorityPolicyConfig(), raw);
      const current = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), raw);
      expect(current.actions).toEqual(legacy.actions);
      expect(current.deadline_evidence.map(item => item.action_id)).toEqual(current.actions.map(item => item.action_id));
      expect(parsePriorityEngineResult(current)).toEqual(current);
      expect(parsePriorityEngineResult(legacy)).toEqual(legacy);
      expect(Object.hasOwn(parsePriorityEngineResult(legacy), "deadline_evidence")).toBe(false);
    }
    const stale = input(); const candidate = (stale["candidates"] as any[])[0];
    candidate.deadline.fresh_until = "2026-08-28T12:00:00.000Z";
    const result = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), stale);
    expect(result.status).toBe("abstained");
    expect(parsePriorityEngineResult(result)).toEqual(result);
  });
  it.each([
    ["wrong action", (value: any) => { value.deadline_evidence[0].action_id = "foreign"; }],
    ["missing entry", (value: any) => { value.deadline_evidence = []; }],
    ["extra entry", (value: any) => { value.deadline_evidence.push(value.deadline_evidence[0]); }],
    ["bucket mismatch", (value: any) => { value.deadline_evidence[0].deadline.due_at = "2026-08-27T13:00:00.000Z"; }],
    ["missing deadline", (value: any) => { value.deadline_evidence[0].deadline = null; }],
    ["foreign reference", (value: any) => { value.deadline_evidence[0].deadline.evidence_ref = "foreign"; }],
    ["future observation", (value: any) => { value.deadline_evidence[0].deadline.observed_at = "2026-08-28T12:00:00.001Z"; }],
    ["stale ranked evidence", (value: any) => { value.deadline_evidence[0].deadline.fresh_until = "2026-08-28T12:00:00.000Z"; }],
    ["unknown deadline field", (value: any) => { value.deadline_evidence[0].deadline.extra = true; }],
    ["v1 extension", (value: any) => { value.schema_version = 1; }],
    ["v2 missing evidence", (value: any) => { delete value.deadline_evidence; }],
  ])("rejects %s", (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(generate())); mutate(value);
    expect(() => parsePriorityEngineResult(value)).toThrow("PRIORITY_RESULT_INVALID");
  });
  it("does not invoke version accessors or proxy traps and returns no caller aliases", () => {
    let calls = 0; const value = generate();
    const accessor = { ...value };
    Object.defineProperty(accessor, "schema_version", { enumerable: true, get() { calls++; return 2; } });
    const proxy = new Proxy(value, { getOwnPropertyDescriptor() { calls++; throw new Error("unsafe"); } });
    for (const raw of [accessor, proxy]) expect(() => parsePriorityEngineResult(raw)).toThrow("PRIORITY_RESULT_INVALID");
    expect(calls).toBe(0);
    const parsed = parsePriorityEngineResult(value);
    (value.deadline_evidence[0]!.deadline as any).due_at = "2026-08-28T14:00:00.000Z";
    expect(parsed.schema_version === 2 && parsed.deadline_evidence[0]?.deadline?.due_at).toBe("2026-08-28T13:00:00.000Z");
  });
});
