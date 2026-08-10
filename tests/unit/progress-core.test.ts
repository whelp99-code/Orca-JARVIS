import { describe, expect, it } from "vitest";
import { parseProgressBatch, serializeProgressReport } from "../../src/index.js";

const hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const batch = { version: 1, worktree: "active", observed_at: "2026-08-09T06:00:00.000Z", assessments: [{ provider: "codex", terminal_id: "a", incarnation_id: "i1", cursor: "10", observation_identity: hash, state: "running" }] } as const;

describe("progress core validation and serialization", () => {
  it("parses the literal golden batch and emits its byte-exact report", () => {
    const parsed = parseProgressBatch(batch);
    const report = serializeProgressReport(parsed.worktree, parsed.observed_at, [{ ...parsed.assessments[0]!, from: null, to: "running" }]);
    expect(report).toEqual({ report_id: "progress_0dde329e6467f00c3fb62288de51ea661e144e2bc651cb9780dd95c51662877b", payload_json: "{\"version\":1,\"report_id\":\"progress_0dde329e6467f00c3fb62288de51ea661e144e2bc651cb9780dd95c51662877b\",\"worktree\":\"active\",\"observed_at\":\"2026-08-09T06:00:00.000Z\",\"transitions\":[{\"provider\":\"codex\",\"terminal_id\":\"a\",\"incarnation_id\":\"i1\",\"cursor\":\"10\",\"from\":null,\"to\":\"running\"}]}", payload_digest: "sha256:9ac4aac6c68864e10559145871e663a6e13a8ebe036c004060cef952505ef3b3" });
  });
  it("rejects non-record inputs, extra fields, duplicate terminals, invalid identifiers and timestamps", () => {
    for (const value of [null, [], { ...batch, version: 2 }, { ...batch, extra: true }, { ...batch, worktree: "   " }, { ...batch, observed_at: "2026-08-09T06:00:00Z" }, { ...batch, assessments: [] }, { ...batch, assessments: [...batch.assessments, { ...batch.assessments[0] }] }]) expect(() => parseProgressBatch(value)).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
    expect(() => parseProgressBatch({ ...batch, worktree: "e\u0301" })).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
    expect(() => parseProgressBatch({ ...batch, assessments: [{ ...batch.assessments[0], observation_identity: "sha256:ABC" }] })).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
  });
  it("covers every strict batch boundary and accepts all six public states", () => {
    const invalid = (value: unknown) => expect(() => parseProgressBatch(value)).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
    invalid({ ...batch, version: "1" }); invalid({ ...batch, assessments: "not-an-array" }); invalid({ worktree: batch.worktree, observed_at: batch.observed_at, assessments: batch.assessments });
    invalid({ ...batch, assessments: [{ provider: "codex", terminal_id: "a", incarnation_id: "i1", cursor: "10", observation_identity: hash }] });
    invalid({ ...batch, assessments: [{ ...batch.assessments[0], extra: true }] }); invalid({ ...batch, assessments: [{ ...batch.assessments[0], terminal_id: "\t" }] });
    invalid({ ...batch, worktree: "x".repeat(4097) }); invalid({ ...batch, assessments: [{ ...batch.assessments[0], terminal_id: "😀".repeat(65) }] });
    expect(parseProgressBatch({ ...batch, worktree: "x".repeat(4096), assessments: [{ ...batch.assessments[0], terminal_id: "😀".repeat(64), incarnation_id: "😀".repeat(64), cursor: null }] }).assessments[0]!.cursor).toBeNull();
    invalid({ ...batch, assessments: [{ ...batch.assessments[0], incarnation_id: "😀".repeat(65) }] }); invalid({ ...batch, assessments: [{ ...batch.assessments[0], cursor: "😀".repeat(65) }] }); invalid({ ...batch, assessments: [{ ...batch.assessments[0], state: "finished" }] });
    invalid({ ...batch, assessments: [{ ...batch.assessments[0], provider: "other" }] }); invalid({ ...batch, assessments: [{ ...batch.assessments[0], cursor: 1 }] });
    invalid({ ...batch, assessments: Array.from({ length: 1001 }, (_, index) => ({ ...batch.assessments[0], terminal_id: `t${index}`, observation_identity: `sha256:${index.toString(16).padStart(64, "0")}` })) });
    expect(parseProgressBatch({ ...batch, assessments: Array.from({ length: 1000 }, (_, index) => ({ ...batch.assessments[0], terminal_id: `t${index}`, observation_identity: `sha256:${index.toString(16).padStart(64, "0")}` })) }).assessments).toHaveLength(1000);
    for (const state of ["running", "needs_input", "approval_required", "verifying", "stopped", "unknown"] as const) expect(parseProgressBatch({ ...batch, assessments: [{ ...batch.assessments[0], state }] }).assessments[0]!.state).toBe(state);
    for (const observed_at of ["2026-02-30T06:00:00.000Z", "2026-08-09T06:00:00.00Z", "2026-08-09T06:00:00.000+00:00", "2026-08-09T06:00:00.000Z "]) invalid({ ...batch, observed_at });
  });
  it("requires a non-empty transition list already sorted by provider, terminal and incarnation", () => {
    expect(() => serializeProgressReport("active", batch.observed_at, [])).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
    expect(() => serializeProgressReport("active", batch.observed_at, [{ provider: "codex", terminal_id: "z", incarnation_id: "i", cursor: null, from: null, to: "running", observation_identity: hash }, { provider: "claude", terminal_id: "a", incarnation_id: "i", cursor: null, from: null, to: "running", observation_identity: hash }])).toThrow(expect.objectContaining({ code: "PROGRESS_INPUT_INVALID" }));
  });
});
