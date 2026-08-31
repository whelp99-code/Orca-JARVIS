import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { memoryEffectValidationOptions, registerMemoryEffectDelegationKey, revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { parseMemoryEffectRequest } from "../../src/memory-effect-write-request.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
const key = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
]), format: "der", type: "pkcs8" });

describe("single-use memory effect delegation", () => {
  it("accepts the pinned Ed25519 key and fails closed after revocation", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
        public_key_pem: createPublicKey(key).export({ format: "pem", type: "spki" }).toString(),
        valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:01.000Z"));
      expect(parseMemoryEffectRequest(request, memoryEffectValidationOptions(db,
        new Date("2026-08-31T00:00:01.000Z"), "provider:fixture"))).toEqual(request);
      revokeMemoryEffectDelegationKey(db, "jarvis:fixture");
      expect(parseMemoryEffectRequest(request, memoryEffectValidationOptions(db,
        new Date("2026-08-31T00:00:01.000Z"), "provider:fixture"))).toBeUndefined();
    } finally { db.close(); }
  });
});
