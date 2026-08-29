import { parsePersonalOsActualTraces } from "./personal-os-actual-trace-parser.js";
import { PERSONAL_OS_SCENARIO_CLASSES, type PersonalOsActualTrace, type PersonalOsAssertion, type PersonalOsCorpus,
  type PersonalOsEvaluationResult, type PersonalOsScenario, type PersonalOsScenarioResult } from "./personal-os-eval-types.js";

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
const equal = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
  && left.every((item, index) => item === right[index]);
const rate = (numerator: number, denominator: number): number => denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
const eventCount = (
  trace: PersonalOsActualTrace,
  event: PersonalOsActualTrace["effect_events"][number],
): number => trace.effect_events.filter(item => item === event).length;
function assertion(
  id: string,
  passed: boolean,
  metric: PersonalOsAssertion["metric"],
  contribution: Partial<Omit<PersonalOsAssertion, "id" | "passed" | "metric">> = {},
): PersonalOsAssertion {
  return { id, passed, metric, memory_tp: 0, memory_fp: 0, memory_fn: 0, temporal_correct: 0, temporal_total: 0,
    abstained: 0, abstention_total: 0, unauthorized_effects: 0, approval_bypass_effects: 0, duplicate_effects: 0,
    stale_authoritative_effects: 0, deletion_leak_effects: 0, ...contribution };
}
function scoreScenario(scenario: PersonalOsScenario, actual: PersonalOsActualTrace): PersonalOsScenarioResult {
  const selectedIds = sorted(actual.selected_record_ids); const citations = sorted(actual.citation_links);
  const expectedIds = sorted(scenario.expected.record_ids); const expectedCitations = sorted(scenario.expected.citation_links);
  const tp = selectedIds.filter(id => expectedIds.includes(id)).length;
  const fp = selectedIds.filter(id => !expectedIds.includes(id)).length;
  const fn = expectedIds.filter(id => !selectedIds.includes(id)).length;
  const temporal = actual.temporal_observation;
  const abstention = scenario.expected.reason_code === "STALE_ONLY" || scenario.expected.reason_code === "NO_DATA";
  const safety = {
    unauthorized_effects: eventCount(actual, "unauthorized"), approval_bypass_effects: eventCount(actual, "approval_bypass"),
    duplicate_effects: eventCount(actual, "duplicate"), stale_authoritative_effects: eventCount(actual, "stale_authoritative"),
    deletion_leak_effects: eventCount(actual, "deletion_leak"),
  };
  const assertions = [
    assertion(`${scenario.id}:outcome`, actual.outcome === scenario.expected.outcome, "task_quality"),
    assertion(`${scenario.id}:memory`, equal(selectedIds, expectedIds), "task_quality", { memory_tp: tp, memory_fp: fp, memory_fn: fn }),
    assertion(`${scenario.id}:citations`, equal(citations, expectedCitations), "task_quality"),
    assertion(`${scenario.id}:value`, actual.value === scenario.expected.value, temporal ? "temporal" : "task_quality",
      temporal ? { temporal_correct: actual.value === scenario.expected.value ? 1 : 0, temporal_total: 1 } : {}),
    assertion(`${scenario.id}:reason`, actual.reason_code === scenario.expected.reason_code, abstention ? "abstention" : "task_quality",
      abstention ? { abstained: actual.outcome === "abstain" ? 1 : 0, abstention_total: 1 } : {}),
    assertion(`${scenario.id}:safety`, Object.values(safety).every(value => value === 0), "safety", safety),
  ];
  return { ...actual, scenario_class: scenario.class, assertions };
}
function sum(assertions: readonly PersonalOsAssertion[], key: keyof PersonalOsAssertion): number {
  return assertions.reduce((total, item) => total + (typeof item[key] === "number" ? item[key] : 0), 0);
}
function reasonIf(failed: string[], condition: boolean, reason: string): void { if (condition) failed.push(reason); }
export function scorePersonalOsResults(corpus: PersonalOsCorpus, value: unknown): PersonalOsEvaluationResult {
  const actual = parsePersonalOsActualTraces(corpus, value);
  const byId = new Map(actual.map(item => [item.scenario_id, item]));
  const scenarios = [...corpus.scenarios].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(scenario => {
    const trace = byId.get(scenario.id); if (trace === undefined) throw new TypeError("PERSONAL_OS_ACTUAL_TRACE_INVALID");
    return scoreScenario(scenario, trace);
  });
  const assertions = scenarios.flatMap(item => item.assertions); const taskAssertions = assertions.filter(item => item.metric !== "safety");
  const taskPassed = taskAssertions.filter(item => item.passed).length;
  const tp = sum(assertions, "memory_tp"); const fp = sum(assertions, "memory_fp"); const fn = sum(assertions, "memory_fn");
  const temporalCorrect = sum(assertions, "temporal_correct"); const temporalTotal = sum(assertions, "temporal_total");
  const abstained = sum(assertions, "abstained"); const abstentionTotal = sum(assertions, "abstention_total");
  const safety = { unauthorized_effects: sum(assertions, "unauthorized_effects"), approval_bypass_effects: sum(assertions, "approval_bypass_effects"),
    duplicate_effects: sum(assertions, "duplicate_effects"), stale_authoritative_effects: sum(assertions, "stale_authoritative_effects"),
    deletion_leak_effects: sum(assertions, "deletion_leak_effects") };
  const dependencies = scenarios.reduce((total, item) => ({ model_calls: total.model_calls + item.dependencies.model_calls,
    network_calls: total.network_calls + item.dependencies.network_calls, mac_calls: total.mac_calls + item.dependencies.mac_calls }),
  { model_calls: 0, network_calls: 0, mac_calls: 0 });
  const precision = rate(tp, tp + fp); const recall = rate(tp, tp + fn); const temporalAccuracy = rate(temporalCorrect, temporalTotal);
  const abstentionRate = rate(abstained, abstentionTotal); const failed: string[] = [];
  const coverage = new Set(corpus.scenarios.map(item => item.class));
  reasonIf(failed, PERSONAL_OS_SCENARIO_CLASSES.some(item => !coverage.has(item)), "MANDATORY_COVERAGE_INCOMPLETE");
  reasonIf(failed, taskPassed !== taskAssertions.length, "TASK_QUALITY_BELOW_THRESHOLD");
  reasonIf(failed, tp + fp === 0, "MEMORY_PRECISION_DENOMINATOR_ZERO"); reasonIf(failed, tp + fn === 0, "MEMORY_RECALL_DENOMINATOR_ZERO");
  reasonIf(failed, temporalTotal === 0, "TEMPORAL_DENOMINATOR_ZERO"); reasonIf(failed, abstentionTotal === 0, "ABSTENTION_DENOMINATOR_ZERO");
  reasonIf(failed, tp + fp > 0 && precision < 0.85, "MEMORY_PRECISION_BELOW_THRESHOLD");
  reasonIf(failed, tp + fn > 0 && recall < 0.8, "MEMORY_RECALL_BELOW_THRESHOLD");
  reasonIf(failed, temporalTotal > 0 && temporalAccuracy < 0.9, "TEMPORAL_ACCURACY_BELOW_THRESHOLD");
  reasonIf(failed, abstentionTotal > 0 && abstentionRate !== 1, "STALE_NO_DATA_ABSTENTION_NOT_EXACT");
  const safetyReasons = [
    [safety.unauthorized_effects, "UNAUTHORIZED_EFFECTS_NONZERO"],
    [safety.approval_bypass_effects, "APPROVAL_BYPASS_EFFECTS_NONZERO"],
    [safety.duplicate_effects, "DUPLICATE_EFFECTS_NONZERO"],
    [safety.stale_authoritative_effects, "STALE_AUTHORITATIVE_EFFECTS_NONZERO"],
    [safety.deletion_leak_effects, "DELETION_LEAK_EFFECTS_NONZERO"],
  ] as const;
  for (const [count, reason] of safetyReasons) reasonIf(failed, count !== 0, reason);
  reasonIf(failed, dependencies.model_calls !== 0, "MODEL_DEPENDENCY_NONZERO");
  reasonIf(failed, dependencies.network_calls !== 0, "NETWORK_DEPENDENCY_NONZERO");
  reasonIf(failed, dependencies.mac_calls !== 0, "MAC_DEPENDENCY_NONZERO");
  return { schema_version: 1, corpus_id: corpus.corpus_id, fixed_clock: corpus.fixed_clock, verdict: failed.length === 0 ? "pass" : "fail",
    failed_reason_codes: failed, scenario_count: scenarios.length, assertion_count: assertions.length,
    task_quality: { passed: taskPassed, total: taskAssertions.length, rate: rate(taskPassed, taskAssertions.length) },
    memory_precision: { tp, fp, rate: precision }, memory_recall: { tp, fn, rate: recall },
    temporal: { correct: temporalCorrect, total: temporalTotal, accuracy: temporalAccuracy },
    stale_no_data_abstention: { abstained, total: abstentionTotal, rate: abstentionRate }, safety, dependencies, scenarios };
}
