import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePersonalOsCorpus } from "../../src/personal-os-corpus-parser.js";
import { runPersonalOsEvalCli } from "../../src/personal-os-eval-cli.js";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { computePersonalOsRecordDigest } from "../../src/personal-os-record-digest.js";
import type { PersonalOsCorpus, PersonalOsRecord } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root);
const bind = (record: PersonalOsRecord): PersonalOsRecord => {
  const digest = computePersonalOsRecordDigest(record); return { ...record, digest, transfer_digest: digest };
};

describe("Task 19 corpus-global integrity and clock", () => {
  it("rejects duplicate record IDs, links, and immutable digests across scenarios", () => {
    // Given: each global identity is forged independently in a second scenario
    const source = corpus(); const first = source.scenarios[0]?.records[0]; const secondScenario = source.scenarios[1];
    const second = secondScenario?.records[0];
    if (first === undefined || secondScenario === undefined || second === undefined) throw new TypeError("fixture records missing");
    const changed = (record: PersonalOsRecord): PersonalOsCorpus => ({ ...source, scenarios: source.scenarios.map(item =>
      item.id === secondScenario.id ? { ...item, records: [record, ...item.records.slice(1)] } : item) });

    // When / Then: corpus-global ambiguity is rejected for every identity material
    expect(() => parsePersonalOsCorpus(changed({ ...second, id: first.id }))).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus(changed({ ...second, evidence_link: first.evidence_link }))).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus(changed({ ...second, digest: first.digest }))).toThrow("PERSONAL_OS_CORPUS_INVALID");
  });

  it("rejects ambiguous subjects, future queries and observations, and contradictory freshness", () => {
    // Given: one otherwise valid record and scenario per chronology/identity adversary
    const source = corpus(); const scenario = source.scenarios[0]; const record = scenario?.records[0];
    if (scenario === undefined || record === undefined) throw new TypeError("fixture record missing");
    const withRecord = (changed: PersonalOsRecord): PersonalOsCorpus => ({ ...source, scenarios: source.scenarios.map(item =>
      item.id === scenario.id ? { ...item, records: [record, changed] } : item) });
    const ambiguous = bind({ ...record, id: "ambiguous-subject", subject: record.subject.toUpperCase(),
      evidence_link: "evidence:synthetic:ambiguous-subject", session_id: "session:ambiguous-subject" });
    const futureObservation = bind({ ...record, observed_at: "2026-08-29T12:30:00.000Z" });
    const contradictory = bind({ ...record, fresh_until: "2026-08-29T14:00:00.000Z" });

    // When / Then: fixed clock and record chronology are hard boundaries
    expect(() => parsePersonalOsCorpus(withRecord(ambiguous))).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus({ ...source, fixed_clock: "2026-08-29T10:00:00.000Z" })).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus({ ...source, scenarios: source.scenarios.map(item => item.id === scenario.id
      ? { ...item, records: [futureObservation] } : item) })).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus({ ...source, scenarios: source.scenarios.map(item => item.id === scenario.id
      ? { ...item, records: [contradictory] } : item) })).toThrow("PERSONAL_OS_CORPUS_INVALID");
  });
});

describe("Task 19 operational error boundary", () => {
  it("preserves unexpected loader errors and maps them to the stable CLI internal code", () => {
    // Given: an unexpected operational read fault injected at the bounded file seam
    const operational = new RangeError("disk controller fault");
    const operations = { realpath: (path: string): string => realpathSync(path), lstat: (path: string) => lstatSync(path),
      readFile: (): string => { throw operational; } };
    let stderr = "";

    // When: programmatic and CLI boundaries encounter the same unexpected fault
    const programmatic = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root, operations);
    const status = runPersonalOsEvalCli({ args: [], fixtureRoot: root, stdout: () => undefined,
      stderr: bytes => { stderr += bytes; }, load: () => programmatic() });

    // Then: the API preserves identity and the CLI never mislabels it as a path failure
    expect(programmatic).toThrow(operational);
    expect(status).toBe(2); expect(stderr).toBe('{"code":"PERSONAL_OS_INTERNAL_ERROR"}\n');
    expect(stderr).not.toContain("PERSONAL_OS_FIXTURE_PATH_INVALID");
  });

  it("retains the real file reader contract for known corpus bytes", () => {
    // Given: production file operations and one valid fixture
    const operations = { realpath: (path: string): string => realpathSync(path), lstat: (path: string) => lstatSync(path),
      readFile: (path: string): string => readFileSync(path, "utf8") };
    // When: the fixture is loaded through the explicit seam
    const loaded = loadPersonalOsCorpus("happy.json", root, operations);
    // Then: its bounded corpus identity is preserved
    expect(loaded.corpus_id).toBe("personal-os-synthetic-v1");
  });
});
