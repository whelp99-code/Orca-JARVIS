import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENING_CLOSEOUT_LIMITS,
  generateEveningCloseout,
  parseEveningCloseoutInput,
} from "../../src/index.js";
import {
  additionalVerifiedRecord,
  closeoutInput,
  futureVerificationRecord,
  signer,
} from "../fixtures/evening-closeout.js";

const generate = (overrides: Readonly<Record<string, number>>, input = closeoutInput()) =>
  generateEveningCloseout(parseEveningCloseoutInput({
    ...input,
    limits: { ...DEFAULT_EVENING_CLOSEOUT_LIMITS, ...overrides },
  }), signer());

describe("evening closeout deterministic bounds", () => {
  it("Given section bounds at minus one, equality, and plus one Then counts are exact", () => {
    const below = generate({ max_completions: 0 });
    const equal = generate({ max_completions: 1 });
    const above = generate({ max_completions: 2 });
    expect(below.verified_completions).toEqual([]);
    expect(below.omissions).toContainEqual({ reason: "completion_cap", count: 1 });
    expect(equal.verified_completions).toHaveLength(1);
    expect(above.verified_completions).toHaveLength(1);
  });

  it("Given candidate and decision bounds Then each section is independently capped", () => {
    const none = generate({ max_candidates: 0, max_decisions: 0 });
    const equal = generate({ max_candidates: 1, max_decisions: 1 });
    const above = generate({ max_candidates: 2, max_decisions: 2 });
    expect(none.eligible_memory_candidate_ids).toEqual([]);
    expect(none.owner_decisions_required).toEqual([]);
    expect(equal.eligible_memory_candidate_ids).toHaveLength(1);
    expect(equal.owner_decisions_required).toHaveLength(1);
    expect(above.eligible_memory_candidate_ids).toHaveLength(1);
  });

  it("Given evidence limits at minus one, equality, and plus one Then completion is honest", () => {
    const below = generate({ max_evidence: 2 });
    const equal = generate({ max_evidence: 3 });
    const above = generate({ max_evidence: 4 });
    expect(below.verified_completions).toEqual([]);
    expect(below.omissions).toContainEqual({ reason: "evidence_cap", count: 2 });
    expect(equal.verified_completions).toHaveLength(1);
    expect(above.verified_completions).toHaveLength(1);
  });

  it("enforces source, citation, and evidence caps over the whole artifact", () => {
    const input = closeoutInput();
    const records = [...input.records, additionalVerifiedRecord()];
    for (const [key, below, equal, above] of [
      ["max_sources", 1, 2, 3],
      ["max_citations", 1, 2, 3],
      ["max_evidence", 5, 6, 7],
    ] as const) {
      const belowArtifact = generate({ [key]: below }, { ...input, records });
      const equalArtifact = generate({ [key]: equal }, { ...input, records });
      const aboveArtifact = generate({ [key]: above }, { ...input, records });
      expect(belowArtifact.verified_completions).toHaveLength(1);
      expect(equalArtifact.verified_completions).toHaveLength(2);
      expect(aboveArtifact.verified_completions).toHaveLength(2);
      expect(belowArtifact.omitted_count).toBeGreaterThan(0);
    }
  });

  it("rejects independently signed verification after the fixed closeout instant", () => {
    const input = closeoutInput();
    expect(() => parseEveningCloseoutInput({
      ...input,
      records: [futureVerificationRecord()],
    })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  });

  it("Given source and citation zero/equality/plus one Then invalid or covered", () => {
    expect(() => parseEveningCloseoutInput({
      ...closeoutInput(),
      limits: { ...DEFAULT_EVENING_CLOSEOUT_LIMITS, max_sources: 0 },
    })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    for (const maximum of [1, 2]) {
      const artifact = generate({ max_sources: maximum, max_citations: maximum });
      const completion = artifact.verified_completions[0];
      expect(completion?.citations).toHaveLength(1);
      expect(completion?.citations[0]?.source_id).toBe("source-one");
    }
  });

  it("Given CJK and emoji UTF8 copy bounds Then truncation never splits a code point", () => {
    const input = closeoutInput();
    const risk = input.risks[0];
    expect(risk).toBeDefined();
    if (risk === undefined) return;
    const risks = [{ ...risk, copy: "한😀aZ" }];
    const below = generate({ max_copy_bytes: 7 }, { ...input, risks });
    const equal = generate({ max_copy_bytes: 8 }, { ...input, risks });
    const above = generate({ max_copy_bytes: 9 }, { ...input, risks });
    expect(below.unresolved_risks[0]?.copy).toBe("한😀");
    expect(equal.unresolved_risks[0]?.copy).toBe("한😀a");
    expect(above.unresolved_risks[0]?.copy).toBe("한😀aZ");
    expect(equal.omissions).toContainEqual({ reason: "copy_truncated", count: 3 });
  });

  it("Given the minimum total-byte bound Then output is deterministically reduced below it", () => {
    const first = generate({ max_total_bytes: 2_048 });
    const second = generate({ max_total_bytes: 2_048 });
    expect(first).toEqual(second);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(2_048);
    expect(first.omitted_count).toBeGreaterThan(0);
  });
});
