import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: {
    readonly correction: { readonly request: MemoryEffectWriteRequestV2 };
    readonly forget: { readonly request: MemoryEffectWriteRequestV2 };
  };
};

describe("permanent JARVIS tombstone high-water", () => {
  it("forms one contiguous immutable chain across correction and deletion", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const chain = new MemoryTombstoneChain(db, Buffer.alloc(32, 8));
      const correction = contract.vectors.correction.request;
      const correctionDelta = correction.tombstone_chain_delta[0];
      if (correctionDelta === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
      const first = chain.append({ operation: "correct", lane_id: correction.lane_id,
        targets: correction.targets, target_manifest_digest: correction.target_manifest_digest,
        scope_digest: correction.scope_digest,
        authority_receipt_digest: correctionDelta.authority_receipt_digest,
        payload_digest: correction.delegation.payload_digest, effective_at: correction.created_at });
      const forget = contract.vectors.forget.request;
      const forgetDelta = forget.tombstone_chain_delta.at(-1);
      if (forgetDelta === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
      const second = chain.append({ operation: "forget", lane_id: forget.lane_id,
        targets: forget.targets, target_manifest_digest: forget.target_manifest_digest,
        scope_digest: forget.scope_digest,
        authority_receipt_digest: forgetDelta.authority_receipt_digest,
        payload_digest: forget.delegation.payload_digest, effective_at: forget.created_at });
      expect(second.entry.sequence).toBe(first.entry.sequence + 1);
      expect(second.entry.previous_root).toBe(first.entry.set_root);
      expect(chain.delta(0)).toEqual([first.entry, second.entry]);
      expect(() => db.db.prepare(
        `INSERT INTO memory_tombstone_chain(
          sequence,tombstone_id,operation,lane_id,target_manifest_digest,scope_digest,
          authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,
          previous_root,set_root,created_at
         ) SELECT 4,tombstone_id||'x',operation,lane_id||'x',target_manifest_digest,scope_digest,
          authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,
          previous_root,set_root||'x',created_at FROM memory_tombstone_chain WHERE sequence=1`,
      ).run()).toThrow(/memory tombstone chain fork/);
    } finally { db.close(); }
  });
});
