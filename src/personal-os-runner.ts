import { computePersonalOsRecordDigest } from "./personal-os-record-digest.js";
import type { PersonalOsActualTrace, PersonalOsCorpus, PersonalOsRecord, PersonalOsScenario } from "./personal-os-eval-types.js";

const ZERO_DEPENDENCIES = { model_calls: 0, network_calls: 0, mac_calls: 0 } as const;
const byIdentity = (left: PersonalOsRecord, right: PersonalOsRecord): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const instant = (value: string): number => Date.parse(value);
function trace(
  scenario: PersonalOsScenario,
  value: Omit<PersonalOsActualTrace, "schema_version" | "scenario_id" | "dependencies" | "effect_events">,
): PersonalOsActualTrace {
  return { schema_version: 1, scenario_id: scenario.id, ...value, effect_events: [], dependencies: ZERO_DEPENDENCIES };
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
function aligned(left: PersonalOsRecord, right: PersonalOsRecord): boolean {
  return left.subject === right.subject && left.value === right.value && left.kind === right.kind && left.state === right.state
    && left.trust === right.trust && left.authority === right.authority && left.observed_at === right.observed_at
    && left.valid_from === right.valid_from && left.valid_until === right.valid_until && left.fresh_until === right.fresh_until;
}
function contributing(records: readonly PersonalOsRecord[]): readonly PersonalOsRecord[] {
  const supports = records.filter(item => item.relationship === "supporting");
  const ranked = records.filter(item => item.relationship === "direct").map(item => ({ item,
    supports: supports.filter(support => aligned(item, support)).sort(byIdentity) }))
    .sort((left, right) => right.supports.length - left.supports.length
      || instant(right.item.observed_at) - instant(left.item.observed_at) || byIdentity(left.item, right.item));
  const selected = ranked[0];
  if (selected === undefined) return [];
  const support = selected.supports[0];
  return support === undefined ? [selected.item] : [selected.item, support].sort(byIdentity);
}
function runScenario(scenario: PersonalOsScenario, tombstones: readonly PersonalOsRecord[]): PersonalOsActualTrace {
  const temporalObservation = hasTemporalHistory(scenario.records.filter(item => item.subject === scenario.query_subject));
  if (scenario.records.some(item => computePersonalOsRecordDigest(item) !== item.digest || item.transfer_digest !== item.digest)) {
    return empty(scenario, "reject", "INTEGRITY_FAILURE", temporalObservation);
  }
  const subject = scenario.records.filter(item => item.subject === scenario.query_subject && item.relationship !== "unrelated");
  const queryTime = instant(scenario.query_at);
  if (tombstones.some(item => item.subject === scenario.query_subject && instant(item.observed_at) <= queryTime)) {
    return empty(scenario, "abstain", "TOMBSTONED", temporalObservation);
  }
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
  const tombstones = corpus.scenarios.flatMap(item => item.records).filter(item => item.state === "deleted")
    .sort((left, right) => instant(left.observed_at) - instant(right.observed_at) || byIdentity(left, right));
  return [...corpus.scenarios].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(scenario => runScenario(scenario, tombstones));
}
