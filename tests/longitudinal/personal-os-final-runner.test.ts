import { describe, expect, it } from "vitest";
import { parsePersonalOsCorpus } from "../../src/personal-os-corpus-parser.js";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { computePersonalOsRecordDigest } from "../../src/personal-os-record-digest.js";
import { runPersonalOsCorpus } from "../../src/personal-os-runner.js";
import type { PersonalOsCorpus, PersonalOsRecord, PersonalOsScenario } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root);
const bind = (record: PersonalOsRecord): PersonalOsRecord => {
  const digest = computePersonalOsRecordDigest(record);
  return { ...record, digest, transfer_digest: digest };
};
const replace = (source: PersonalOsCorpus, scenario: PersonalOsScenario): PersonalOsCorpus => ({
  ...source, scenarios: source.scenarios.map(item => item.id === scenario.id ? scenario : item),
});
const actual = (source: PersonalOsCorpus, scenarioId: string) =>
  runPersonalOsCorpus(source).find(item => item.scenario_id === scenarioId);

describe("Task 19 valid-time tombstones", () => {
  it("answers before effectiveness and tombstones at equality and after despite later restores", () => {
    // Given: historical evidence, a deletion effective at 10:00, a second deletion, and a later restore
    const source = corpus(); const base = source.scenarios.find(item => item.class === "tombstone_restore");
    const template = base?.records[0];
    if (base === undefined || template === undefined) throw new TypeError("tombstone fixture missing");
    const historical = bind({ ...template, id: "history-live", state: "active", value: "old-channel",
      observed_at: "2026-08-29T09:00:00.000Z", evidence_link: "evidence:synthetic:history-live", session_id: "session:history-live" });
    const deletion = bind({ ...template, observed_at: "2026-08-29T10:00:00.000Z" });
    const secondDeletion = bind({ ...template, id: "tombstone-second", observed_at: "2026-08-29T10:30:00.000Z",
      evidence_link: "evidence:synthetic:tombstone-second", session_id: "session:tombstone-second" });
    const restore = bind({ ...template, id: "restore-later", state: "active", value: "restored-channel",
      observed_at: "2026-08-29T11:00:00.000Z", evidence_link: "evidence:synthetic:restore-later", session_id: "session:restore-later" });
    const scenario = { ...base, records: [restore, secondDeletion, historical, deletion] };
    const at = (query_at: string): PersonalOsCorpus => replace(source, { ...scenario, query_at });

    // When: the same immutable chronology is queried around deletion effectiveness
    const beforeCorpus = parsePersonalOsCorpus(at("2026-08-29T09:30:00.000Z"));
    const before = actual(beforeCorpus, base.id);
    const equal = actual(at("2026-08-29T10:00:00.000Z"), base.id);
    const after = actual(at("2026-08-29T12:00:00.000Z"), base.id);

    // Then: history remains valid strictly before deletion and every later identity reuse remains suppressed
    expect(before).toMatchObject({ outcome: "answer", selected_record_ids: ["history-live"], value: "old-channel" });
    expect(equal).toMatchObject({ outcome: "abstain", selected_record_ids: [], reason_code: "TOMBSTONED" });
    expect(after).toMatchObject({ outcome: "abstain", selected_record_ids: [], reason_code: "TOMBSTONED" });
    expect(actual(replace(source, { ...scenario, records: [...scenario.records].reverse() }), base.id)).toEqual(after);
  });

  it("rejects a tombstone whose effectiveness is ambiguous with its valid start", () => {
    // Given: a deletion with no strict immutable chronology between validity and observation
    const source = corpus(); const scenario = source.scenarios.find(item => item.class === "deletion_prevention");
    const record = scenario?.records[0];
    if (scenario === undefined || record === undefined) throw new TypeError("deletion fixture missing");
    const ambiguous = bind({ ...record, observed_at: record.valid_from });

    // When / Then: the corpus boundary rejects the ambiguous effectiveness
    expect(() => parsePersonalOsCorpus(replace(source, { ...scenario, records: [ambiguous] })))
      .toThrow("PERSONAL_OS_CORPUS_INVALID");
  });
});

describe("Task 19 stable multi-session contribution", () => {
  it("keeps the minimal direct and supporting pair across noise chronology and corpus order", () => {
    // Given: an established content-aligned pair plus newer, older, same-time, unrelated, and untrusted noise
    const source = corpus(); const scenario = source.scenarios.find(item => item.class === "multi_session");
    const direct = scenario?.records.find(item => item.relationship === "direct");
    if (scenario === undefined || direct === undefined) throw new TypeError("multi-session fixture missing");
    const noise = (id: string, observed_at: string): PersonalOsRecord => bind({ ...direct, id, observed_at,
      evidence_link: `evidence:synthetic:${id}`, session_id: `session:${id}` });
    const sameTime = noise("multi-same-noise", direct.observed_at);
    const additions = [noise("multi-newer-noise", "2026-08-29T11:00:00.000Z"),
      noise("multi-older-noise", "2026-08-29T09:30:00.000Z"), sameTime,
      bind({ ...sameTime, id: "multi-unrelated", relationship: "unrelated", evidence_link: "evidence:synthetic:multi-unrelated",
        session_id: "session:multi-unrelated" }), bind({ ...sameTime, id: "multi-injection", trust: "untrusted",
        evidence_link: "evidence:synthetic:multi-injection", session_id: "session:multi-injection" })];
    const changed = replace(source, { ...scenario, records: [...additions, ...scenario.records] });

    // When: records and corpus bytes are independently reordered
    const selected = actual(changed, scenario.id);
    const changedScenario = changed.scenarios.find(item => item.id === scenario.id);
    if (changedScenario === undefined) throw new TypeError("changed scenario missing");
    const reordered = actual(replace(source, { ...scenario, records: [...changedScenario.records].reverse() }), scenario.id);

    // Then: only the immutable content-aligned direct/supporting contributors are selected and cited
    expect(selected).toMatchObject({ selected_record_ids: ["multi-1", "multi-2"],
      citation_links: ["evidence:synthetic:multi-1", "evidence:synthetic:multi-2"] });
    expect(reordered).toEqual(selected);
  });
});
