import { describe, expect, it } from "vitest";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { runPersonalOsCorpus, scorePersonalOsResults } from "../../src/personal-os-evaluator.js";
import type { PersonalOsActualTrace, PersonalOsCorpus } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root);
const replaceTrace = (
  traces: readonly PersonalOsActualTrace[],
  scenarioId: string,
  change: (trace: PersonalOsActualTrace) => PersonalOsActualTrace,
): readonly PersonalOsActualTrace[] => traces.map(item => item.scenario_id === scenarioId ? change(item) : item);

describe("Task 19 exact metric threshold edges", () => {
  it("accepts precision 17/20 and rejects 16/20", () => {
    // Given: independently observable retrievals at and below the exact precision edge
    const source = corpus(); const first = source.scenarios[0]; const trace = runPersonalOsCorpus(source)[0];
    if (first === undefined || trace === undefined) throw new TypeError("fixture missing");
    const expectedIds = [...first.expected.record_ids, ...new Array(6).fill(0).map((_, index) => `tp-${index}`)];
    const changed = { ...source, scenarios: source.scenarios.map(item => item.id === first.id
      ? { ...item, expected: { ...item.expected, record_ids: expectedIds } } : item) };
    const atIds = [...trace.selected_record_ids, ...expectedIds.slice(1), "fp-1", "fp-2", "fp-3"];
    const belowIds = [...atIds.filter(item => item !== "tp-0"), "fp-4"];

    // When: the independent scorer consumes each trace
    const at = scorePersonalOsResults(changed, replaceTrace(runPersonalOsCorpus(source), first.id,
      item => ({ ...item, selected_record_ids: atIds })));
    const below = scorePersonalOsResults(changed, replaceTrace(runPersonalOsCorpus(source), first.id,
      item => ({ ...item, selected_record_ids: belowIds })));

    // Then: equality passes and the lower ratio fails
    expect(at.memory_precision).toEqual({ tp: 17, fp: 3, rate: 0.85 });
    expect(at.failed_reason_codes).not.toContain("MEMORY_PRECISION_BELOW_THRESHOLD");
    expect(below.memory_precision).toEqual({ tp: 16, fp: 4, rate: 0.8 });
    expect(below.failed_reason_codes).toContain("MEMORY_PRECISION_BELOW_THRESHOLD");
  });

  it("accepts recall 4/5 and rejects 3/5", () => {
    // Given: an oracle and actual traces reduced to one five-record retrieval contract
    const source = corpus(); const first = source.scenarios[0];
    if (first === undefined) throw new TypeError("fixture missing");
    const expectedIds = ["one", "two", "three", "four", "five"];
    const changed = { ...source, scenarios: source.scenarios.map(item => ({ ...item, expected: { ...item.expected,
      record_ids: item.id === first.id ? expectedIds : [] } })) };
    const cleared = runPersonalOsCorpus(source).map(item => ({ ...item, selected_record_ids: [] }));

    // When: four and then three oracle IDs are retrieved
    const at = scorePersonalOsResults(changed, replaceTrace(cleared, first.id,
      item => ({ ...item, selected_record_ids: expectedIds.slice(0, 4) })));
    const below = scorePersonalOsResults(changed, replaceTrace(cleared, first.id,
      item => ({ ...item, selected_record_ids: expectedIds.slice(0, 3) })));

    // Then: equality passes and the lower ratio fails
    expect(at.memory_recall).toEqual({ tp: 4, fn: 1, rate: 0.8 });
    expect(at.failed_reason_codes).not.toContain("MEMORY_RECALL_BELOW_THRESHOLD");
    expect(below.memory_recall).toEqual({ tp: 3, fn: 2, rate: 0.6 });
    expect(below.failed_reason_codes).toContain("MEMORY_RECALL_BELOW_THRESHOLD");
  });

  it("accepts temporal 9/10 and exact abstention 1/1 while rejecting lower edges", () => {
    // Given: ten temporal observations and one stale/no-data oracle observation
    const source = corpus(); const traces = runPersonalOsCorpus(source);
    const temporalIds = traces.slice(0, 10).map(item => item.scenario_id);
    const temporal = traces.map(item => ({ ...item, temporal_observation: temporalIds.includes(item.scenario_id) }));
    const changed = { ...source, scenarios: source.scenarios.map(item => temporalIds.includes(item.id)
      ? { ...item, expected: { ...item.expected, value: temporalIds[9] === item.id ? "wrong" : item.expected.value } } : item) };
    const staleScenarios = changed.scenarios.filter(item => item.expected.reason_code === "STALE_ONLY"
      || item.expected.reason_code === "NO_DATA");
    const retained = staleScenarios[0]; const excluded = staleScenarios[1];
    if (retained === undefined || excluded === undefined) throw new TypeError("abstention fixtures missing");
    const oneAbstention = { ...changed, scenarios: changed.scenarios.map(item => item.id === excluded.id
      ? { ...item, expected: { ...item.expected, reason_code: "NO_MATCH" } } : item) };

    // When: one more temporal answer and the retained abstention are made incorrect
    const temporalBelow = { ...oneAbstention, scenarios: oneAbstention.scenarios.map(item => item.id === temporalIds[8]
      ? { ...item, expected: { ...item.expected, value: "also-wrong" } } : item) };
    const abstentionBelow = replaceTrace(temporal, retained.id, item => ({ ...item, outcome: "answer" }));
    const at = scorePersonalOsResults(oneAbstention, temporal);
    const temporalFail = scorePersonalOsResults(temporalBelow, temporal);
    const abstentionFail = scorePersonalOsResults(oneAbstention, abstentionBelow);

    // Then: both exact edges are enforced
    expect(at.temporal).toEqual({ correct: 9, total: 10, accuracy: 0.9 });
    expect(at.stale_no_data_abstention).toEqual({ abstained: 1, total: 1, rate: 1 });
    expect(at.failed_reason_codes).not.toContain("TEMPORAL_ACCURACY_BELOW_THRESHOLD");
    expect(temporalFail.temporal).toEqual({ correct: 8, total: 10, accuracy: 0.8 });
    expect(temporalFail.failed_reason_codes).toContain("TEMPORAL_ACCURACY_BELOW_THRESHOLD");
    expect(abstentionFail.failed_reason_codes).toContain("STALE_NO_DATA_ABSTENTION_NOT_EXACT");
  });
});
