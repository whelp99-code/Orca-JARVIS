import { describe, expect, it } from "vitest";
import { computePersonalOsRecordDigest } from "../../src/personal-os-record-digest.js";
import { evaluatePersonalOsCorpus, runPersonalOsCorpus, scorePersonalOsResults } from "../../src/personal-os-evaluator.js";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import type { PersonalOsActualTrace, PersonalOsCorpus, PersonalOsRecord } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root);
const replaceScenario = (
  source: PersonalOsCorpus,
  scenarioId: string,
  change: (scenario: PersonalOsCorpus["scenarios"][number]) => PersonalOsCorpus["scenarios"][number],
): PersonalOsCorpus => ({ ...source, scenarios: source.scenarios.map(item => item.id === scenarioId ? change(item) : item) });
const bind = (record: PersonalOsRecord): PersonalOsRecord => {
  const digest = computePersonalOsRecordDigest(record);
  return { ...record, digest, transfer_digest: digest };
};

describe("Task 19 record-derived remediation", () => {
  it("keeps actual behavior invariant when conflict and owner coverage labels change", () => {
    // Given: one ordinary answered scenario relabeled as two coverage classes
    const source = corpus(); const target = source.scenarios.find(item => item.class === "exact_source");
    if (target === undefined) throw new TypeError("exact scenario missing");
    const baseline = runPersonalOsCorpus(source).find(item => item.scenario_id === target.id);

    // When: only coverage metadata changes
    const conflictCorpus = replaceScenario(source, target.id, item => ({ ...item, class: "conflict_abstention" }));
    const ownerCorpus = replaceScenario(source, target.id, item => ({ ...item, class: "owner_gated_decision" }));
    const conflict = runPersonalOsCorpus(conflictCorpus).find(item => item.scenario_id === target.id);
    const owner = runPersonalOsCorpus(ownerCorpus).find(item => item.scenario_id === target.id);

    // Then: record-derived traces are unchanged
    expect(conflict).toEqual(baseline); expect(owner).toEqual(baseline);
  });

  it("changes scoring but not actual behavior when the expected oracle changes", () => {
    // Given: a valid full corpus and a changed expected outcome
    const source = corpus(); const target = source.scenarios[0];
    if (target === undefined) throw new TypeError("scenario missing");
    const changed = replaceScenario(source, target.id, item => ({ ...item, expected: { ...item.expected, outcome: "abstain" } }));

    // When: both corpora run and score
    const actual = runPersonalOsCorpus(source); const changedActual = runPersonalOsCorpus(changed);
    const score = scorePersonalOsResults(changed, changedActual);

    // Then: oracle bytes never enter the runner, while exact task quality fails
    expect(changedActual).toEqual(actual);
    expect(score.verdict).toBe("fail"); expect(score.failed_reason_codes).toContain("TASK_QUALITY_BELOW_THRESHOLD");
  });

  it("rejects stale immutable bindings and arbitrary equal hashes", () => {
    // Given: every immutable field is changed independently without rebinding
    const source = corpus(); const target = source.scenarios[0]; const record = target?.records[0];
    if (target === undefined || record === undefined) throw new TypeError("record missing");
    const mutations: readonly PersonalOsRecord[] = [
      { ...record, subject: `${record.subject}-changed` }, { ...record, value: `${record.value}-changed` },
      { ...record, kind: "gap" }, { ...record, state: "stale" }, { ...record, trust: "inferred" },
      { ...record, authority: "owner" }, { ...record, session_id: `${record.session_id}-changed` },
      { ...record, observed_at: "2026-08-29T10:01:00.000Z" }, { ...record, valid_from: "2026-08-29T09:01:00.000Z" },
      { ...record, valid_until: "2026-08-29T12:59:00.000Z" }, { ...record, fresh_until: "2026-08-29T12:59:00.000Z" },
      { ...record, evidence_link: `${record.evidence_link}-changed` }, { ...record, relationship: "unrelated" },
      { ...record, digest: `sha256:${"f".repeat(64)}`, transfer_digest: `sha256:${"f".repeat(64)}` },
    ];

    // When / Then: retained or forged bindings produce an integrity rejection
    for (const mutation of mutations) {
      const changed = replaceScenario(source, target.id, item => ({ ...item, records: [mutation, ...item.records.slice(1)] }));
      const actual = runPersonalOsCorpus(changed).find(item => item.scenario_id === target.id);
      expect(actual).toMatchObject({ outcome: "reject", reason_code: "INTEGRITY_FAILURE" });
    }
  });

  it("selects only deterministic contributing sessions and honors tombstone dominance", () => {
    // Given: same-value direct noise and a later restore after a tombstone
    const source = corpus(); const multi = source.scenarios.find(item => item.class === "multi_session");
    const tombstone = source.scenarios.find(item => item.class === "tombstone_restore");
    const original = multi?.records[0];
    if (multi === undefined || tombstone === undefined || original === undefined) throw new TypeError("fixture scenario missing");
    const noise = bind({ ...original, id: "multi-noise", evidence_link: "evidence:synthetic:multi-noise",
      session_id: "session:multi-noise", observed_at: "2026-08-29T09:30:00.000Z" });
    const changed = replaceScenario(source, multi.id, item => ({ ...item, records: [...item.records, noise] }));

    // When: record-derived retrieval executes
    const traces = runPersonalOsCorpus(changed);
    const multiTrace = traces.find(item => item.scenario_id === multi.id);
    const tombstoneTrace = traces.find(item => item.scenario_id === tombstone.id);

    // Then: noise is not cited and deletion cannot be resurrected
    expect(multiTrace?.selected_record_ids).not.toContain(noise.id);
    expect(new Set(multiTrace?.session_ids).size).toBeGreaterThan(1);
    expect(tombstoneTrace).toMatchObject({ outcome: "abstain", selected_record_ids: [], reason_code: "TOMBSTONED" });
  });
});

describe("Task 19 observable scoring seam", () => {
  it("fails each injected safety effect and runtime dependency with its exact reason", () => {
    // Given: shipped deterministic traces and every bounded observable mutation
    const source = corpus(); const traces = runPersonalOsCorpus(source); const first = traces[0];
    if (first === undefined) throw new TypeError("trace missing");
    const cases = [
      ["unauthorized", "UNAUTHORIZED_EFFECTS_NONZERO"], ["approval_bypass", "APPROVAL_BYPASS_EFFECTS_NONZERO"],
      ["duplicate", "DUPLICATE_EFFECTS_NONZERO"], ["stale_authoritative", "STALE_AUTHORITATIVE_EFFECTS_NONZERO"],
      ["deletion_leak", "DELETION_LEAK_EFFECTS_NONZERO"],
    ] as const;

    // When / Then: each observable effect independently fails its exact gate
    for (const [event, reason] of cases) {
      const injected: readonly PersonalOsActualTrace[] = [{ ...first, effect_events: [event] }, ...traces.slice(1)];
      expect(scorePersonalOsResults(source, injected).failed_reason_codes).toContain(reason);
    }
    const dependencies = [["model_calls", "MODEL_DEPENDENCY_NONZERO"], ["network_calls", "NETWORK_DEPENDENCY_NONZERO"],
      ["mac_calls", "MAC_DEPENDENCY_NONZERO"]] as const;
    for (const [dependency, reason] of dependencies) {
      const injected: readonly PersonalOsActualTrace[] = [
        { ...first, dependencies: { ...first.dependencies, [dependency]: 1 } }, ...traces.slice(1),
      ];
      expect(scorePersonalOsResults(source, injected).failed_reason_codes).toContain(reason);
    }
  });

  it("fails zero denominators and missing mandatory coverage", () => {
    // Given: a tiny corpus lacking temporal, abstention, and complete coverage
    const source = corpus(); const first = source.scenarios[0];
    if (first === undefined) throw new TypeError("scenario missing");
    const tiny = { ...source, scenarios: [first] };
    const emptyExpected = { outcome: "abstain", record_ids: [], citation_links: [], value: null, reason_code: "NO_MATCH" } as const;
    const empty: PersonalOsCorpus = { ...tiny, scenarios: [{ ...first, expected: emptyExpected }] };
    const trace = runPersonalOsCorpus(empty)[0];
    if (trace === undefined) throw new TypeError("trace missing");

    // When: tiny and empty benchmark dimensions are independently scored
    const result = scorePersonalOsResults(tiny, runPersonalOsCorpus(tiny));
    const zero = scorePersonalOsResults(empty, [{ ...trace, outcome: "abstain", selected_record_ids: [], citation_links: [],
      session_ids: [], value: null, reason_code: "NO_MATCH" }]);

    // Then: missing coverage and empty benchmark dimensions never become perfect scores
    expect(result.failed_reason_codes).toEqual(expect.arrayContaining([
      "MANDATORY_COVERAGE_INCOMPLETE", "TEMPORAL_DENOMINATOR_ZERO", "ABSTENTION_DENOMINATOR_ZERO",
    ]));
    expect(zero.failed_reason_codes).toEqual(expect.arrayContaining([
      "MEMORY_PRECISION_DENOMINATOR_ZERO", "MEMORY_RECALL_DENOMINATOR_ZERO",
    ]));
  });

  it("fails every independently removed mandatory coverage class", () => {
    // Given: the complete benchmark with each coverage class removed in turn
    const source = corpus(); const classes = new Set(source.scenarios.map(item => item.class));
    // When / Then: no reduced corpus can claim a full-benchmark pass
    for (const scenarioClass of classes) {
      const reduced = { ...source, scenarios: source.scenarios.filter(item => item.class !== scenarioClass) };
      expect(evaluatePersonalOsCorpus(reduced).failed_reason_codes).toContain("MANDATORY_COVERAGE_INCOMPLETE");
    }
  });

  it("keeps the shipped full benchmark passing with zero dependencies", () => {
    // Given: the complete synthetic benchmark
    const source = corpus();
    // When: the composed evaluator runs
    const result = evaluatePersonalOsCorpus(source);
    // Then: quality and runtime dependency gates are exact
    expect(result).toMatchObject({ verdict: "pass", task_quality: { rate: 1 },
      dependencies: { model_calls: 0, network_calls: 0, mac_calls: 0 } });
  });
});
