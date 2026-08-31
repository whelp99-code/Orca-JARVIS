import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { memoryEffectDigest } from "../../src/memory-effect-write-values.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";

const vector = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: {
    readonly request: MemoryEffectWriteRequestV2; readonly request_digest: string;
    readonly idempotency_key: string; readonly delegation_digest: string;
    readonly envelope_digest: string; readonly request_file_digest: string;
    readonly envelope_bytes: number;
  } };
}).vectors.correction;

describe("frozen memory-effect wire vector", () => {
  it("preserves every frozen digest and byte count", () => {
    expect(vector.request_digest).toBe("sha256:3b785d65b826d91040d99a1f1a99f4981547bc2909c20ddda39295e4a1c10ffa");
    expect(vector.idempotency_key).toBe("memeff:idem:v2:a20ebd9e20342f9a7317b62e130cc830b5a865b3c29a30a844a642166c432da5");
    expect(vector.delegation_digest).toBe("sha256:d84204150a9cdb69db7e60357b3ca2120f69d7cd2dec04dadfaf0f9f48e00944");
    expect(vector.envelope_digest).toBe("sha256:3f324697dd8c0e69c3ea29f76b945282be3f16ff5935ed49c997597fa33c807e");
    expect(vector.request_file_digest).toBe("sha256:71f682a8318e85032290d02c96b165e28320d2188141e0899053cf4c1d4b47ec");
    expect(Buffer.byteLength(canonicalize(vector.request), "utf8")).toBe(vector.envelope_bytes);
  });

  it("keeps request identity independent from the later signature field", () => {
    const effectSpec = Object.fromEntries(Object.entries(vector.request).filter(([name]) =>
      !["request_id", "request_digest", "idempotency_key", "delegation", "envelope_digest"].includes(name)));
    expect(memoryEffectDigest("effect_spec", effectSpec)).toBe(vector.request.request_digest);
    const changed = { ...vector.request, delegation: { ...vector.request.delegation,
      signature: `${vector.request.delegation.signature.slice(0, -1)}A` } };
    const changedSpec = Object.fromEntries(Object.entries(changed).filter(([name]) =>
      !["request_id", "request_digest", "idempotency_key", "delegation", "envelope_digest"].includes(name)));
    expect(memoryEffectDigest("effect_spec", changedSpec)).toBe(vector.request.request_digest);
  });
});
