import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { parseSecondBrainWriteRequest } from "../../src/second-brain-write-request.js";
import { parseSecondBrainWriteResult } from "../../src/second-brain-write-result.js";
import { snapshotMemoryWriteArguments } from "../../src/memory-effect-write-request.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { providerWriteIdempotencyKey } from "../../src/memory-candidate-dispatch-receipts.js";
import type { SecondBrainWriteRequestV3 } from "../../src/second-brain-adapter-types.js";

const fixture = JSON.parse(readFileSync("contracts/second-brain-mcp-v3.json", "utf8")).vectors.remember_v3 as {
  request: SecondBrainWriteRequestV3; request_file_digest: string; envelope_bytes: string;
};
const request = fixture.request;
const now = new Date(request.created_at);
const accepted = { schema_version: 3, kind: "accepted", state: "pending", candidate_id: request.candidate_id,
  request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
  operation: request.operation, accepted_at: request.created_at, inbox_path: `inbox/.requests/pending/${request.request_id}.json`,
  request_file_digest: fixture.request_file_digest, replayed: false };

describe("shared provider V3 remember vector", () => {
  it("validates Python-generated request bytes, raw content, projection, idempotency and file envelope", () => {
    expect(parseSecondBrainWriteRequest(request, now)).toEqual(request);
    expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
    expect(providerWriteIdempotencyKey(request)).toBe(request.idempotency_key);
    expect(memoryRememberArtifact(request).record_texts).toEqual(["첫 결정", "두 번째 결정", "반복", "반복 \\[\\^user]"]);
    const stored = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "schema_version"));
    stored.receipt = Object.fromEntries(Object.entries(request.receipt).filter(([key]) => key !== "schema_version"));
    const bytes = `${canonicalize({ schema_version: 3, state: "pending", accepted_at: request.created_at, request: stored })}\n`;
    expect(bytes).toBe(fixture.envelope_bytes);
    expect(`sha256:${createHash("sha256").update("second-brain/inbox-write-request/v3\0").update(bytes.slice(0, -1)).digest("hex")}`)
      .toBe(fixture.request_file_digest);
    expect(parseSecondBrainWriteResult(accepted)).toEqual(accepted);
  });
  it("rejects content newline normalization, wire downgrades and malformed accepted versions", () => {
    for (const changed of [{ ...request, payload: { content: request.payload.content!.replaceAll("\r\n", "\n") } },
      { ...request, schema_version: 1 }, { ...request, body_profile: "other" },
      { ...request, request_id: request.request_id.replace(":v3:", ":v1:") }]) {
      expect(parseSecondBrainWriteRequest(changed, now)).toBeUndefined();
    }
    for (const changed of [{ ...accepted, schema_version: 1 }, { ...accepted, schema_version: "3" },
      { ...accepted, operation: "correct" }, { ...accepted, body_profile: "plain-text-v1" }]) {
      expect(parseSecondBrainWriteResult(changed)).toBeUndefined();
    }
  });
});
