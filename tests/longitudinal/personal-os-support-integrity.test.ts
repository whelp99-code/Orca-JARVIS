import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { parsePersonalOsCorpus } from "../../src/personal-os-corpus-parser.js";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { computePersonalOsRecordDigest } from "../../src/personal-os-record-digest.js";
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
const invalid = (source: unknown): void => {
  expect(() => parsePersonalOsCorpus(source)).toThrow("PERSONAL_OS_CORPUS_INVALID");
};

describe("Task 19 explicit contributor integrity", () => {
  it("binds support targets into independently recomputed canonical digests", () => {
    // Given: the shipped supporter and an independently assembled canonical digest material
    const source = corpus(); const scenario = source.scenarios.find(item => item.class === "multi_session");
    const support = scenario?.records.find(item => item.relationship === "supporting");
    if (scenario === undefined || support === undefined) throw new TypeError("support fixture missing");
    const material = { authority: support.authority, evidence_link: support.evidence_link, fresh_until: support.fresh_until,
      id: support.id, kind: support.kind, observed_at: support.observed_at, relationship: support.relationship,
      session_id: support.session_id, state: support.state, subject: support.subject, support_for: support.support_for,
      trust: support.trust, valid_from: support.valid_from, valid_until: support.valid_until, value: support.value };
    const independent = `sha256:${createHash("sha256").update(canonicalize(material), "utf8").digest("hex")}`;

    // When: support identity is mutated while retaining its old transfer binding
    const stale = { ...support, support_for: "missing-target" };

    // Then: independent bytes agree, mutation changes the digest, and stale bindings reject
    expect(independent).toBe(support.digest);
    expect(computePersonalOsRecordDigest(stale)).not.toBe(support.digest);
    invalid(replace(source, { ...scenario, records: scenario.records.map(item => item.id === support.id ? stale : item) }));
  });

  it("rejects missing, dangling, self, chain, cycle, cross-scenario, and duplicate support", () => {
    // Given: one valid direct/support pair and independent referential adversaries
    const source = corpus(); const scenario = source.scenarios.find(item => item.class === "multi_session");
    const direct = scenario?.records.find(item => item.relationship === "direct");
    const support = scenario?.records.find(item => item.relationship === "supporting");
    const foreign = source.scenarios.find(item => item.id !== scenario?.id)?.records[0];
    if (scenario === undefined || direct === undefined || support === undefined || foreign === undefined) {
      throw new TypeError("support fixtures missing");
    }
    const changed = (records: readonly PersonalOsRecord[]): PersonalOsCorpus => replace(source, { ...scenario, records });
    const dangling = bind({ ...support, support_for: "missing-target" });
    const self = bind({ ...support, support_for: support.id });
    const crossScenario = bind({ ...support, support_for: foreign.id });
    const chained = bind({ ...direct, relationship: "supporting", support_for: support.id });
    const cycledSupport = bind({ ...support, support_for: direct.id });
    const duplicate = bind({ ...support, id: "multi-3", evidence_link: "evidence:synthetic:multi-3",
      session_id: "session:gamma" });

    // When / Then: every ambiguous or non-local graph is rejected at the corpus boundary
    for (const records of [[direct, dangling], [direct, self], [direct, crossScenario], [chained, support],
      [chained, cycledSupport], [direct, support, duplicate]]) invalid(changed(records));
    const missingSupport = Object.fromEntries(Object.entries(support).filter(([key]) => key !== "support_for"));
    invalid({ ...source, scenarios: source.scenarios.map(item => item.id === scenario.id
      ? { ...scenario, records: [direct, missingSupport] } : item) });
    invalid(changed([direct, bind({ ...support, support_for: null })]));
  });

  it("rejects mismatched content, authority, chronology, session, lifecycle, and trust", () => {
    // Given: one valid direct/support pair with each eligibility dimension changed independently
    const source = corpus(); const scenario = source.scenarios.find(item => item.class === "multi_session");
    const direct = scenario?.records.find(item => item.relationship === "direct");
    const support = scenario?.records.find(item => item.relationship === "supporting");
    if (scenario === undefined || direct === undefined || support === undefined) throw new TypeError("support fixtures missing");
    const mutations: readonly PersonalOsRecord[] = [
      bind({ ...support, subject: "other-subject" }), bind({ ...support, value: "other-value" }),
      bind({ ...support, kind: "principle" }), bind({ ...support, authority: "owner" }),
      bind({ ...support, observed_at: "2026-08-29T10:01:00.000Z" }),
      bind({ ...support, valid_from: "2026-08-29T09:01:00.000Z" }),
      bind({ ...support, valid_until: "2026-08-29T12:59:00.000Z", fresh_until: "2026-08-29T12:59:00.000Z" }),
      bind({ ...support, session_id: direct.session_id }), bind({ ...support, state: "stale" }),
      bind({ ...support, state: "no_data" }), bind({ ...support, trust: "untrusted" }),
      bind({ ...support, trust: "inferred" }),
    ];
    const deletedTarget = bind({ ...direct, state: "deleted" });

    // When / Then: no ineligible contributor or tombstoned target can form a pair
    for (const mutation of mutations) invalid(replace(source, { ...scenario, records: [direct, mutation] }));
    invalid(replace(source, { ...scenario, records: [deletedTarget, support] }));
  });
});
