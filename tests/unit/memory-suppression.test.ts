import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { isMemorySuppressed, suppressMemoryProjection } from "../../src/memory-suppression.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const target = fixture(request.targets[0]);
const tombstoneDelta = fixture(request.tombstone_chain_delta[0]);

describe("immediate memory suppression", () => {
  it("filters every matching projection as soon as the chain appends", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      new MemoryTombstoneChain(db, Buffer.alloc(32, 1)).append({ operation: "correct",
        lane_id: request.lane_id, targets: [target], target_manifest_digest: request.target_manifest_digest,
        scope_digest: request.scope_digest,
        authority_receipt_digest: tombstoneDelta.authority_receipt_digest,
        payload_digest: request.delegation.payload_digest, effective_at: request.created_at });
      expect(isMemorySuppressed(db, { target_digest: target.target_digest })).toBe(true);
      const projection = [{ id: "old", target: target.target_digest }, { id: "other", target: `sha256:${"f".repeat(64)}` }];
      expect(suppressMemoryProjection(db, projection, value => ({ target_digest: value.target })))
        .toEqual([{ id: "other", target: `sha256:${"f".repeat(64)}` }]);
    } finally { db.close(); }
  });
});
