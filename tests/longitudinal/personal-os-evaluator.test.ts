import { describe, expect, it } from "vitest";
import { evaluatePersonalOsCorpus } from "../../src/personal-os-evaluator.js";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { PERSONAL_OS_SCENARIO_CLASSES, type PersonalOsAssertion } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
function independent(assertions: readonly PersonalOsAssertion[]) {
  const sum = (key: keyof PersonalOsAssertion): number => assertions.reduce(
    (total, item) => total + (typeof item[key] === "number" ? item[key] : 0), 0,
  );
  const ratio = (top: number, bottom: number): number => bottom === 0 ? 1 : Number((top / bottom).toFixed(6));
  const tp = sum("memory_tp"); const fp = sum("memory_fp"); const fn = sum("memory_fn");
  const temporalCorrect = sum("temporal_correct"); const temporalTotal = sum("temporal_total");
  const abstained = sum("abstained"); const abstentionTotal = sum("abstention_total");
  return { assertions: assertions.length, taskPassed: assertions.filter(item => item.passed).length,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), temporal: ratio(temporalCorrect, temporalTotal),
    abstention: ratio(abstained, abstentionTotal), unauthorized: sum("unauthorized_effects"),
    approvalBypass: sum("approval_bypass_effects"), duplicate: sum("duplicate_effects"),
    stale: sum("stale_authoritative_effects"), deletion: sum("deletion_leak_effects") };
}

describe("Task 19 longitudinal scenario execution", () => {
  it("executes every mandatory scenario class and derives passing metrics from assertions", () => {
    // Given: the fixed private-safe happy corpus
    const corpus = loadPersonalOsCorpus("happy.json", root);

    // When: shipped deterministic retrieval and assertion logic executes
    const result = evaluatePersonalOsCorpus(corpus);
    const assertions = result.scenarios.flatMap(item => item.assertions);
    const totals = independent(assertions);

    // Then: all classes, thresholds, counters, and independently recomputed totals agree
    expect([...new Set(result.scenarios.map(item => item.scenario_class))].sort()).toEqual([...PERSONAL_OS_SCENARIO_CLASSES].sort());
    expect(result).toMatchObject({ verdict: "pass", scenario_count: 17, assertion_count: 102,
      task_quality: { passed: totals.taskPassed, total: totals.assertions },
      memory_precision: { tp: 12, fp: 0, rate: totals.precision }, memory_recall: { tp: 12, fn: 0, rate: totals.recall },
      temporal: { correct: 3, total: 3, accuracy: totals.temporal },
      stale_no_data_abstention: { abstained: 2, total: 2, rate: totals.abstention },
      safety: { unauthorized_effects: totals.unauthorized, approval_bypass_effects: totals.approvalBypass,
        duplicate_effects: totals.duplicate, stale_authoritative_effects: totals.stale, deletion_leak_effects: totals.deletion } });
    expect(result.failed_reason_codes).toEqual([]);
  });

  it("changes independently recomputed totals when one machine assertion changes", () => {
    // Given: one evaluated assertion stream and a one-assertion regression
    const result = evaluatePersonalOsCorpus(loadPersonalOsCorpus("happy.json", root));
    const assertions = result.scenarios.flatMap(item => item.assertions);
    const [first, ...remaining] = assertions;
    if (first === undefined) throw new TypeError("fixture assertion missing");
    const mutated = [{ ...first, passed: false, memory_fp: 2 }, ...remaining];

    // When: metrics are recomputed only from per-scenario assertions
    const original = independent(assertions);
    const changed = independent(mutated);

    // Then: quality and precision change rather than trusting prior aggregate bytes
    expect(changed.taskPassed).toBe(original.taskPassed - 1);
    expect(changed.precision).toBeLessThan(original.precision);
  });

  it("fails the known threshold fixture with only the exact recall reason", () => {
    // Given: a valid corpus with one expected memory that retrieval excludes
    const corpus = loadPersonalOsCorpus("failing-recall.json", root);

    // When: the evaluator derives its metrics
    const result = evaluatePersonalOsCorpus(corpus);

    // Then: recall fails deterministically and no safety effect is introduced
    expect(result).toMatchObject({ verdict: "fail", memory_recall: { tp: 0, fn: 1, rate: 0 },
      failed_reason_codes: ["MEMORY_RECALL_BELOW_THRESHOLD"],
      safety: { unauthorized_effects: 0, approval_bypass_effects: 0, duplicate_effects: 0,
        stale_authoritative_effects: 0, deletion_leak_effects: 0 } });
  });

  it("never retrieves, cites, or scores deleted evidence and never executes an owner gate", () => {
    // Given: evaluated deletion and owner-decision scenarios
    const result = evaluatePersonalOsCorpus(loadPersonalOsCorpus("happy.json", root));

    // When: their observable outputs are selected
    const deletion = result.scenarios.filter(item => item.scenario_class === "tombstone_restore" || item.scenario_class === "deletion_prevention");
    const owner = result.scenarios.find(item => item.scenario_class === "owner_gated_decision");

    // Then: tombstones are absent and the owner item remains a decision with zero effects
    expect(deletion.flatMap(item => item.selected_record_ids)).not.toContain("tombstone-old");
    expect(deletion.flatMap(item => item.selected_record_ids)).not.toContain("deleted-only");
    expect(deletion.flatMap(item => item.citation_links).join(" ")).not.toMatch(/tombstone-old|deleted-only/);
    expect(owner).toMatchObject({ outcome: "decision", reason_code: "OWNER_APPROVAL_REQUIRED" });
    expect(result.safety).toEqual({ unauthorized_effects: 0, approval_bypass_effects: 0, duplicate_effects: 0,
      stale_authoritative_effects: 0, deletion_leak_effects: 0 });
  });
});
