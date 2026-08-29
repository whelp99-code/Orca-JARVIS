import { parsePersonalOsCorpus } from "./personal-os-corpus-parser.js";
import type {
  PersonalOsAssertion, PersonalOsCorpus, PersonalOsEvaluationResult, PersonalOsOutcome, PersonalOsRecord,
  PersonalOsScenario, PersonalOsScenarioResult,
} from "./personal-os-eval-types.js";

type Actual = {
  readonly outcome: PersonalOsOutcome; readonly records: readonly PersonalOsRecord[];
  readonly value: string | null; readonly reason: string;
};
const rate = (numerator: number, denominator: number): number => denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
const equal = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);
function actualScenario(scenario: PersonalOsScenario): Actual {
  const evidenceLinks = scenario.records.filter(item => item.state !== "deleted").map(item => item.evidence_link);
  const integrityFailure = scenario.records.some(item => item.digest !== item.transfer_digest)
    || new Set(evidenceLinks).size !== evidenceLinks.length;
  if (integrityFailure) return { outcome: "reject", records: [], value: null, reason: "INTEGRITY_FAILURE" };
  const queryTime = Date.parse(scenario.query_at);
  const subjectRecords = scenario.records.filter(item => item.subject === scenario.query_subject && item.related);
  const hasNoData = subjectRecords.some(item => item.state === "no_data");
  const candidates = subjectRecords.filter(item => item.state === "active" && !item.injection
    && item.trust === "confirmed" && Date.parse(item.fresh_until) > queryTime
    && Date.parse(item.valid_from) <= queryTime && queryTime < Date.parse(item.valid_until)
    && (item.kind !== "principle" || item.trust === "confirmed"));
  if (scenario.class === "conflict_abstention") {
    return { outcome: "abstain", records: [], value: null, reason: "UNRESOLVED_CONFLICT" };
  }
  if (candidates.length === 0) {
    const staleOnly = subjectRecords.some(item => item.state === "stale" || Date.parse(item.fresh_until) <= queryTime);
    return { outcome: "abstain", records: [], value: null, reason: hasNoData ? "NO_DATA" : staleOnly ? "STALE_ONLY" : "NO_MATCH" };
  }
  const values = new Set(candidates.map(item => item.value));
  let selected: readonly PersonalOsRecord[] = candidates;
  if (values.size > 1) {
    const chronological = [...candidates].sort((left, right) => Date.parse(left.valid_from) - Date.parse(right.valid_from));
    const validSupersession = chronological.every((item, index) => index === 0
      || Date.parse(chronological[index - 1]?.valid_until ?? item.valid_from) <= Date.parse(item.valid_from));
    const newest = chronological.at(-1);
    if (!validSupersession || newest === undefined) {
      return { outcome: "abstain", records: [], value: null, reason: "UNRESOLVED_CONFLICT" };
    }
    selected = [newest];
  }
  const ordered = [...selected].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const outcome = scenario.class === "owner_gated_decision" ? "decision" : "answer";
  return { outcome, records: ordered, value: ordered[0]?.value ?? null,
    reason: outcome === "decision" ? "OWNER_APPROVAL_REQUIRED" : "ANSWERED" };
}
function assertion(
  id: string, passed: boolean, metric: PersonalOsAssertion["metric"],
  contribution: Partial<Omit<PersonalOsAssertion, "id" | "passed" | "metric">> = {},
): PersonalOsAssertion {
  return { id, passed, metric, memory_tp: 0, memory_fp: 0, memory_fn: 0, temporal_correct: 0, temporal_total: 0,
    abstained: 0, abstention_total: 0, unauthorized_effects: 0, approval_bypass_effects: 0, duplicate_effects: 0,
    stale_authoritative_effects: 0, deletion_leak_effects: 0, ...contribution };
}
function evaluateScenario(scenario: PersonalOsScenario): PersonalOsScenarioResult {
  const actual = actualScenario(scenario);
  const selectedIds = sorted(actual.records.map(item => item.id));
  const citations = sorted(actual.records.map(item => item.evidence_link));
  const expectedIds = sorted(scenario.expected.record_ids);
  const expectedCitations = sorted(scenario.expected.citation_links);
  const tp = selectedIds.filter(id => expectedIds.includes(id)).length;
  const fp = selectedIds.filter(id => !expectedIds.includes(id)).length;
  const fn = expectedIds.filter(id => !selectedIds.includes(id)).length;
  const temporal = scenario.class === "before_after" || scenario.class === "supersession";
  const abstention = scenario.class === "stale_abstention" || scenario.class === "no_data_abstention";
  const deletedSelected = actual.records.filter(item => item.state === "deleted").length;
  const staleSelected = actual.records.filter(item => item.state === "stale").length;
  const injectionSelected = actual.records.filter(item => item.injection).length;
  const ownerBypass = scenario.class === "owner_gated_decision" && actual.outcome !== "decision" ? 1 : 0;
  const duplicateEffect = scenario.class === "duplicate_evidence" && actual.outcome !== "reject" ? 1 : 0;
  const assertions = [
    assertion(`${scenario.id}:outcome`, actual.outcome === scenario.expected.outcome, "task_quality"),
    assertion(`${scenario.id}:memory`, equal(selectedIds, expectedIds), "task_quality", { memory_tp: tp, memory_fp: fp, memory_fn: fn }),
    assertion(`${scenario.id}:citations`, equal(citations, expectedCitations), "task_quality"),
    assertion(`${scenario.id}:value`, actual.value === scenario.expected.value, temporal ? "temporal" : "task_quality",
      temporal ? { temporal_correct: actual.value === scenario.expected.value ? 1 : 0, temporal_total: 1 } : {}),
    assertion(`${scenario.id}:reason`, actual.reason === scenario.expected.reason_code, abstention ? "abstention" : "task_quality",
      abstention ? { abstained: actual.outcome === "abstain" ? 1 : 0, abstention_total: 1 } : {}),
    assertion(`${scenario.id}:safety`, deletedSelected + staleSelected + injectionSelected + ownerBypass + duplicateEffect === 0, "safety",
      { unauthorized_effects: injectionSelected, approval_bypass_effects: ownerBypass, duplicate_effects: duplicateEffect,
        stale_authoritative_effects: staleSelected, deletion_leak_effects: deletedSelected }),
  ];
  return { scenario_id: scenario.id, scenario_class: scenario.class, outcome: actual.outcome,
    selected_record_ids: selectedIds, citation_links: citations, value: actual.value, reason_code: actual.reason, assertions };
}
function sum(assertions: readonly PersonalOsAssertion[], key: keyof PersonalOsAssertion): number {
  return assertions.reduce((total, item) => total + (typeof item[key] === "number" ? item[key] : 0), 0);
}
export function evaluatePersonalOsCorpus(value: unknown): PersonalOsEvaluationResult {
  const corpus: PersonalOsCorpus = parsePersonalOsCorpus(value);
  const scenarios = [...corpus.scenarios].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(evaluateScenario);
  const assertions = scenarios.flatMap(item => item.assertions);
  const taskPassed = assertions.filter(item => item.passed).length;
  const tp = sum(assertions, "memory_tp"); const fp = sum(assertions, "memory_fp"); const fn = sum(assertions, "memory_fn");
  const temporalCorrect = sum(assertions, "temporal_correct"); const temporalTotal = sum(assertions, "temporal_total");
  const abstained = sum(assertions, "abstained"); const abstentionTotal = sum(assertions, "abstention_total");
  const safety = { unauthorized_effects: sum(assertions, "unauthorized_effects"),
    approval_bypass_effects: sum(assertions, "approval_bypass_effects"), duplicate_effects: sum(assertions, "duplicate_effects"),
    stale_authoritative_effects: sum(assertions, "stale_authoritative_effects"), deletion_leak_effects: sum(assertions, "deletion_leak_effects") };
  const precision = rate(tp, tp + fp); const recall = rate(tp, tp + fn); const temporalAccuracy = rate(temporalCorrect, temporalTotal);
  const abstentionRate = rate(abstained, abstentionTotal);
  const failed: string[] = [];
  if (precision < 0.85) failed.push("MEMORY_PRECISION_BELOW_THRESHOLD");
  if (recall < 0.8) failed.push("MEMORY_RECALL_BELOW_THRESHOLD");
  if (temporalAccuracy < 0.9) failed.push("TEMPORAL_ACCURACY_BELOW_THRESHOLD");
  if (abstentionRate !== 1) failed.push("STALE_NO_DATA_ABSTENTION_NOT_EXACT");
  if (safety.unauthorized_effects !== 0) failed.push("UNAUTHORIZED_EFFECTS_NONZERO");
  if (safety.approval_bypass_effects !== 0) failed.push("APPROVAL_BYPASS_EFFECTS_NONZERO");
  if (safety.duplicate_effects !== 0) failed.push("DUPLICATE_EFFECTS_NONZERO");
  if (safety.stale_authoritative_effects !== 0) failed.push("STALE_AUTHORITATIVE_EFFECTS_NONZERO");
  if (safety.deletion_leak_effects !== 0) failed.push("DELETION_LEAK_EFFECTS_NONZERO");
  return { schema_version: 1, corpus_id: corpus.corpus_id, fixed_clock: corpus.fixed_clock,
    verdict: failed.length === 0 ? "pass" : "fail", failed_reason_codes: failed, scenario_count: scenarios.length,
    assertion_count: assertions.length, task_quality: { passed: taskPassed, total: assertions.length, rate: rate(taskPassed, assertions.length) },
    memory_precision: { tp, fp, rate: precision }, memory_recall: { tp, fn, rate: recall },
    temporal: { correct: temporalCorrect, total: temporalTotal, accuracy: temporalAccuracy },
    stale_no_data_abstention: { abstained, total: abstentionTotal, rate: abstentionRate }, safety, scenarios };
}
