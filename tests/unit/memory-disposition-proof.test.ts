import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb } from "../../src/db.js";
import { verifyMemoryDispositionProof } from "../../src/memory-disposition-proof.js";
import { registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const tombstoneDelta = fixture(request.tombstone_chain_delta[0]);
const providerKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32)),
]), format: "der", type: "pkcs8" });

function proof() {
  const body = { schema_version: 1, proof_type: "correction", provider_instance_id: request.provider_instance_id,
    provider_release_sha: "a".repeat(40), provider_signing_key_id: "provider:key",
    request_id: request.request_id, request_digest: request.request_digest,
    envelope_digest: request.envelope_digest, idempotency_key: request.idempotency_key,
    delegation_id: request.delegation.delegation_id, delegation_digest: request.delegation.delegation_digest,
    lane_id: request.lane_id, operation: request.operation, payload_digest: request.delegation.payload_digest,
    target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
    base_generation_id: request.expected_prior.generation_id, base_head: request.expected_prior.vault_head,
    base_tree: request.expected_prior.vault_tree, result_generation_id: `sbgen:v1:${"b".repeat(64)}`,
    result_head: "c".repeat(40), result_tree: "d".repeat(40),
    tombstone_sequence: request.tombstone_high_water.sequence,
    tombstone_previous_root: tombstoneDelta.previous_root,
    tombstone_set_root: request.tombstone_high_water.set_root,
    activation_journal_digest: `sha256:${"1".repeat(64)}`, reader_drain_digest: `sha256:${"2".repeat(64)}`,
    predecessor_disposal_digest: `sha256:${"3".repeat(64)}`, backup_disposal_digest: `sha256:${"4".repeat(64)}`,
    export_disposal_digest: `sha256:${"5".repeat(64)}`, surface_manifest_digest: `sha256:${"6".repeat(64)}`,
    artifact_manifest_digest: `sha256:${"7".repeat(64)}`, export_manifest_digest: null,
    claimed_at: "2026-08-31T00:00:01.000Z", applied_at: "2026-08-31T00:00:02.000Z",
    completed_at: "2026-08-31T00:00:03.000Z" };
  const proofDigest = `sha256:${createHash("sha256").update("second-brain/memory-disposition-proof/v1\0")
    .update(canonicalize(body)).digest("hex")}`;
  const unsigned = { ...body, proof_id: `sbproof:v1:${proofDigest.slice(7)}`, proof_digest: proofDigest };
  return { ...unsigned, signature: sign(null,
    Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(unsigned)}`), providerKey).toString("base64url") };
}

describe("provider disposition proof", () => {
  it.each([
    ["2026-08-31T00:00:00.000Z", true],
    ["2026-08-31T00:00:03.000Z", true],
    ["2026-08-31T00:00:03.001Z", false],
  ] as const)("binds proof completion to key validity beginning %s", async (validFrom, allowed) => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      registerMemoryProviderProofKey(db, { key_id: "provider:key", provider_instance_id: request.provider_instance_id,
        provider_release_sha: "a".repeat(40), public_key_pem: createPublicKey(providerKey)
          .export({ format: "pem", type: "spki" }).toString(),
        valid_from: validFrom, valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      const expected = { provider_instance_id: request.provider_instance_id, request_id: request.request_id,
        request_digest: request.request_digest, envelope_digest: request.envelope_digest,
        idempotency_key: request.idempotency_key, delegation_id: request.delegation.delegation_id,
        delegation_digest: request.delegation.delegation_digest, lane_id: request.lane_id,
        operation: request.operation, payload_digest: request.delegation.payload_digest,
        target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
        tombstone_sequence: request.tombstone_high_water.sequence,
        tombstone_set_root: request.tombstone_high_water.set_root };
      const verify = () => verifyMemoryDispositionProof(db, proof(), expected,
        new Date("2026-08-31T00:00:04.000Z"));
      if (allowed) expect(verify().proof_type).toBe("correction");
      else expect(verify).toThrow("MEMORY_PROVIDER_PROOF_KEY_INVALID");
      expect(() => verifyMemoryDispositionProof(db, { ...proof(), envelope_digest: `sha256:${"0".repeat(64)}` },
        expected, new Date("2026-08-31T00:00:04.000Z"))).toThrow("MEMORY_PROVIDER_PROOF_BINDING_INVALID");
    } finally { db.close(); }
  });
});
