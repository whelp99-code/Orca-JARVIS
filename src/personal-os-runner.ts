import { computePersonalOsRecordDigest } from "./personal-os-record-digest.js";
import type { PersonalOsActualTrace, PersonalOsCorpus, PersonalOsRecord, PersonalOsScenario } from "./personal-os-eval-types.js";

const ZERO_DEPENDENCIES = { model_calls: 0, network_calls: 0, mac_calls: 0 } as const;
const byIdentity = (left: PersonalOsRecord, right: PersonalOsRecord): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const instant = (value: string): number => Date.parse(value);
function trace(scenario: PersonalOsScenario, value: Omit<PersonalOsActualTrace, "scenario_id" | "dependencies" | "effect_events">): PersonalOsActualTrace {
  return { scenario_id: scenario.id, ...value, effect_events: [], dependencies: ZERO_DEPENDENCIES };
}
function empty(scenario: PersonalOsScenario, outcome: "abstain" | "reject", reasonCode: string, temporalObservation = false): PersonalOsActualTrace {
  return trace(scenario, { outcome, selected_record_ids: [], citation_links: [], session_ids: [], value: null,
    reason_code: reasonCode, temporal_observation: temporalObservation });
}
function hasTemporalHistory(records: readonly PersonalOsRecord[]): boolean {
  const history = records.filter(item => item.state === "active" && item.trust === "confirmed" && item.relationship !== "unrelated")
    .sort((left, right) => instant(left.valid_from) - instant(right.valid_from) || byIdentity(left, right));
  if (history.length < 2) return false;
  return history.every((item, index) => index === 0 || instant(history[index - 1]?.valid_until ?? item.valid_from) <= instant(item.valid_from));
}
function contributing(records: readonly PersonalOsRecord[]): readonly PersonalOsRecord[] {
  const direct = records.filter(item => item.relationship === "direct")
    .sort((left, right) => instant(right.observed_at) - instant(left.observed_at) || byIdentity(left, right))[0];
  if (direct === undefined) return [];
  const supporting = records.filter(item => item.relationship === "supporting" && item.value === direct.value)
    .sort((left, right) => instant(right.observed_at) - instant(left.observed_at) || byIdentity(left, right))[0];
  return supporting === undefined ? [direct] : [direct, supporting].sort(byIdentity);
}
function runScenario(scenario: PersonalOsScenario, tombstonedSubjects: ReadonlySet<string>): PersonalOsActualTrace {
  const temporalObservation = hasTemporalHistory(scenario.records.filter(item => item.subject === scenario.query_subject));
  if (scenario.records.some(item => computePersonalOsRecordDigest(item) !== item.digest || item.transfer_digest !== item.digest)) {
    return empty(scenario, "reject", "INTEGRITY_FAILURE", temporalObservation);
  }
  const subject = scenario.records.filter(item => item.subject === scenario.query_subject && item.relationship !== "unrelated");
  if (tombstonedSubjects.has(scenario.query_subject)) return empty(scenario, "abstain", "TOMBSTONED", temporalObservation);
  const queryTime = instant(scenario.query_at);
  const candidates = subject.filter(item => item.state === "active" && item.trust === "confirmed"
    && instant(item.observed_at) <= queryTime && instant(item.fresh_until) > queryTime
    && instant(item.valid_from) <= queryTime && queryTime < instant(item.valid_until));
  if (candidates.length === 0) {
    if (subject.some(item => item.state === "no_data")) return empty(scenario, "abstain", "NO_DATA", temporalObservation);
    const stale = subject.some(item => item.state === "stale" || instant(item.fresh_until) <= queryTime);
    return empty(scenario, "abstain", stale ? "STALE_ONLY" : "NO_MATCH", temporalObservation);
  }
  if (new Set(candidates.map(item => item.value)).size > 1) return empty(scenario, "abstain", "UNRESOLVED_CONFLICT", temporalObservation);
  const selected = contributing(candidates);
  if (selected.length === 0) return empty(scenario, "abstain", "NO_MATCH", temporalObservation);
  const ownerDecision = selected.some(item => item.authority === "owner");
  return trace(scenario, {
    outcome: ownerDecision ? "decision" : "answer", selected_record_ids: selected.map(item => item.id),
    citation_links: selected.map(item => item.evidence_link).sort(), session_ids: selected.map(item => item.session_id).sort(),
    value: selected[0]?.value ?? null, reason_code: ownerDecision ? "OWNER_APPROVAL_REQUIRED" : "ANSWERED", temporal_observation: temporalObservation,
  });
}
export function runPersonalOsCorpus(corpus: PersonalOsCorpus): readonly PersonalOsActualTrace[] {
  const tombstonedSubjects = new Set(corpus.scenarios.flatMap(item => item.records)
    .filter(item => item.state === "deleted").map(item => item.subject));
  return [...corpus.scenarios].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(scenario => runScenario(scenario, tombstonedSubjects));
}
