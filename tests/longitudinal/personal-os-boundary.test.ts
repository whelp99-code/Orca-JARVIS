import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePersonalOsCorpus, PersonalOsCorpusError } from "../../src/personal-os-corpus-parser.js";
import { loadPersonalOsCorpus, PersonalOsFixtureError } from "../../src/personal-os-eval-file.js";

const fixtureRoot = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): ReturnType<typeof loadPersonalOsCorpus> => loadPersonalOsCorpus("happy.json", fixtureRoot);

describe("Task 19 closed bounded corpus boundary", () => {
  it("rejects unknown, missing, aggregate-tampered, versioned, duplicate, and oversized values", () => {
    // Given: valid bytes changed across each closed-schema boundary class
    const valid = corpus();
    const [first, second] = valid.scenarios;
    if (first === undefined || second === undefined) throw new TypeError("fixture scenarios missing");
    const cases: readonly unknown[] = [
      { ...valid, unknown: true },
      { schema_version: valid.schema_version, corpus_id: valid.corpus_id, fixed_clock: valid.fixed_clock },
      { ...valid, memory_precision: { tp: 999 } },
      { ...valid, schema_version: 2 },
      { ...valid, scenarios: [first, { ...second, id: first.id }] },
      { ...valid, corpus_id: "x".repeat(513) },
      { ...valid, scenarios: new Array(65).fill(first) },
    ];

    // When / Then: every invalid shape fails with the stable typed code
    for (const value of cases) {
      expect(() => parsePersonalOsCorpus(value)).toThrowError(PersonalOsCorpusError);
      expect(() => parsePersonalOsCorpus(value)).toThrow("PERSONAL_OS_CORPUS_INVALID");
    }
  });

  it("rejects accessors and sparse or ambiguous arrays without invoking getters", () => {
    // Given: programmatic values with traps that JSON cannot represent
    let getterReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "schema_version", { enumerable: true, get: () => { getterReads += 1; return 1; } });
    const sparse = { ...corpus(), scenarios: new Array(1) };
    const ambiguous = { ...corpus(), scenarios: Object.assign([...corpus().scenarios], { extra: "value" }) };

    // When / Then: descriptors are rejected before source-controlled evaluation
    expect(() => parsePersonalOsCorpus(accessor)).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus(sparse)).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(() => parsePersonalOsCorpus(ambiguous)).toThrow("PERSONAL_OS_CORPUS_INVALID");
    expect(getterReads).toBe(0);
  });

  it("rejects invalid instants, digests, evidence links, and duplicate record IDs", () => {
    // Given: one otherwise-valid scenario for each semantic boundary failure
    const valid = corpus(); const [scenario] = valid.scenarios;
    if (scenario === undefined) throw new TypeError("fixture scenario missing");
    const [record] = scenario.records;
    if (record === undefined) throw new TypeError("fixture record missing");
    const changed = (records: readonly unknown[], queryAt = scenario.query_at) => ({ ...valid,
      scenarios: [{ ...scenario, query_at: queryAt, records }] });
    const cases = [
      changed([{ ...record, digest: "sha256:bad" }]),
      changed([{ ...record, evidence_link: "../../private" }]),
      changed([{ ...record }, { ...record }]),
      changed([record], "2026-08-29 12:00:00"),
    ];

    // When / Then: malformed evidence never reaches evaluation
    for (const value of cases) expect(() => parsePersonalOsCorpus(value)).toThrow("PERSONAL_OS_CORPUS_INVALID");
  });

  it("confines fixture reads against traversal, symlinks, malformed JSON, and duplicate JSON keys", () => {
    // Given: an isolated fixture root with malformed and escaping candidates
    const root = mkdtempSync(join(tmpdir(), "jarvis-personal-os-boundary-"));
    const outside = join(tmpdir(), `jarvis-personal-os-outside-${process.pid}.json`);
    try {
      writeFileSync(join(root, "malformed.json"), "{not-json", "utf8");
      writeFileSync(join(root, "duplicate.json"), '{"schema_version":1,"schema_version":1}', "utf8");
      writeFileSync(outside, readFileSync(join(fixtureRoot, "happy.json"), "utf8"), "utf8");
      symlinkSync(outside, join(root, "escape.json"));

      // When / Then: path and byte failures are typed and no output surface exists
      expect(() => loadPersonalOsCorpus("../happy.json", root)).toThrowError(PersonalOsFixtureError);
      expect(() => loadPersonalOsCorpus("escape.json", root)).toThrow("PERSONAL_OS_FIXTURE_PATH_INVALID");
      expect(() => loadPersonalOsCorpus("malformed.json", root)).toThrow("PERSONAL_OS_FIXTURE_READ_INVALID");
      expect(() => loadPersonalOsCorpus("duplicate.json", root)).toThrow("PERSONAL_OS_FIXTURE_READ_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it("contains zero production identity, credential, absolute-home, or email patterns", () => {
    // Given: every committed Task 19 corpus byte
    const bytes = ["happy.json", "failing-recall.json"].map(name => readFileSync(join(fixtureRoot, name), "utf8")).join("\n");

    // When: privacy-sensitive patterns are scanned
    const matches = [/(?:\/home\/|\/Users\/)/g, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
      /(?:sk-|ghp_|glpat-|AKIA)[A-Za-z0-9_-]{8,}/g, /(?:authorization|api[_-]?key|password|secret)\s*[:=]/gi]
      .flatMap(pattern => bytes.match(pattern) ?? []);

    // Then: the invented corpus has no production-like private material
    expect(matches).toEqual([]);
  });
});
