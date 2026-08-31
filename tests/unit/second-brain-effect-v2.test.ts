import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createMemoryEffectWriteRequest, createMemoryReadFence, EXTERNAL_ERASURE_SIGNATURE_DOMAIN,
  memoryEffectDigest, parseMemoryEffectWriteRequest,
  type MemoryEffectDelegationV2, type MemoryEffectSpecV2, type MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  vectors: Record<string, Record<string, unknown>>;
};
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
]), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);
const expected = {
  correction: {
    request_digest: "sha256:3b785d65b826d91040d99a1f1a99f4981547bc2909c20ddda39295e4a1c10ffa",
    envelope_digest: "sha256:3f324697dd8c0e69c3ea29f76b945282be3f16ff5935ed49c997597fa33c807e",
    request_file_digest: "sha256:71f682a8318e85032290d02c96b165e28320d2188141e0899053cf4c1d4b47ec",
    envelope_bytes: 6426,
  },
  export: {
    request_digest: "sha256:160c29d0aa51391bad00d5f907fac1de5a6e4fb65e6109116752e91dea60e547",
    envelope_digest: "sha256:02d2dee97b9de45eb807c348c306075b973494e06846272dd6aaf6d5679cbaa1",
    request_file_digest: "sha256:bd12b027d00c9c9924ba8f348ed33c3b695fd66817630aff7233645d31a6ca8a",
    envelope_bytes: 5586,
  },
  forget: {
    request_digest: "sha256:13d7c62b3bcd9d6f0679fbd5a2a91ca8e503a8e98d1d2c2270df87fed7303401",
    envelope_digest: "sha256:8db39e03a91e901bc88d579b2b23c221279b6229f5b7cf27fab950ad97739d31",
    request_file_digest: "sha256:a8b9f0d05e443ee70c12bbe8aab14738b448106ff7ce5c3b144dd148783c7a0f",
    envelope_bytes: 6329,
  },
} as const;
function request(name: keyof typeof expected): MemoryEffectWriteRequestV2 {
  const raw = contract.vectors[name]?.request;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("vector missing");
  return raw as MemoryEffectWriteRequestV2;
}
function specification(value: MemoryEffectWriteRequestV2): MemoryEffectSpecV2 {
  const { request_id, request_digest, idempotency_key, envelope_digest, delegation, ...spec } = value;
  void request_id; void request_digest; void idempotency_key; void envelope_digest; void delegation;
  return spec;
}

describe("Task 30 frozen memory-effect vectors", () => {
  it.each(["correction", "export", "forget"] as const)("matches the cross-repository %s envelope", name => {
    const vector = contract.vectors[name]; const value = request(name); const delegation = value.delegation;
    const parsed = parseMemoryEffectWriteRequest(value, {
      now: new Date("2026-08-31T00:00:01.000Z"), expectedProvider: "provider:fixture",
      delegationKeys: new Map([["jarvis:fixture", publicKey]]), externalReceiptKeys: new Map(),
    });
    expect(parsed).toBeDefined();
    expect(value.request_digest).toBe(expected[name].request_digest);
    expect(value.envelope_digest).toBe(expected[name].envelope_digest);
    expect(Buffer.byteLength(canonicalize(value), "utf8")).toBe(expected[name].envelope_bytes);
    expect(memoryEffectDigest("request_file", {
      schema_version: 2, state: "pending", accepted_at: "2026-08-31T00:00:01.000Z", request: value,
    })).toBe(expected[name].request_file_digest);
    expect(vector?.request_file_digest).toBe(expected[name].request_file_digest);
    const rebuilt = createMemoryEffectWriteRequest(specification(value), {
      principal_id: "principal:owner", not_before: delegation.not_before, nonce: delegation.nonce,
      signing_key_id: delegation.signing_key_id,
    }, privateKey);
    expect(rebuilt).toEqual(value);
  });

  it("requires a pinned external-owner receipt for read-only source suppression", () => {
    const base = request("forget"); const original = base.targets[0]; const chain = base.tombstone_chain_delta[0];
    if (original === undefined || chain === undefined) throw new Error("forget vector malformed");
    const externalPrivate = createPrivateKey({ key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index + 64)),
    ]), format: "der", type: "pkcs8" });
    const { target_id: _targetId, target_digest: _targetDigest, ...targetCore } = original;
    void _targetId; void _targetDigest;
    const ownerDigest = `sha256:${"a".repeat(64)}`;
    const changedCore = { ...targetCore, source_owner_class: "external_read_only" as const,
      source_owner_id_digest: ownerDigest };
    const changedDigest = memoryEffectDigest("target", changedCore);
    const target = { ...changedCore, target_id: `sbtarget:v1:${changedDigest.slice(7)}`, target_digest: changedDigest };
    const targetManifest = memoryEffectDigest("target_manifest", { targets: [target] });
    const scope = { ...base.scope, source_owner_classes: ["external_read_only"] as const };
    const scopeDigest = memoryEffectDigest("target_scope", { target_digests: [changedDigest], scope });
    const receiptBody = { owner_id_digest: ownerDigest, scope_digest: scopeDigest,
      deleted_at: "2026-08-31T00:00:00.000Z", signing_key_id: "external:fixture" };
    const receiptDigest = memoryEffectDigest("external_receipt", receiptBody);
    const unsignedReceipt = { ...receiptBody, receipt_id: `exterase:v1:${receiptDigest.slice(7)}`,
      receipt_digest: receiptDigest };
    const receipt = { ...unsignedReceipt, signature: sign(null,
      Buffer.from(EXTERNAL_ERASURE_SIGNATURE_DOMAIN + canonicalize(unsignedReceipt)), externalPrivate).toString("base64url") };
    const build = (withReceipt: boolean): MemoryEffectWriteRequestV2 => {
      const payload = { disposition: "owner_requested" as const, erasure_claim: "provider_local_suppression" as const,
        external_receipts: withReceipt ? [receipt] : [] };
      const payloadDigest = memoryEffectDigest("effect_payload", payload);
      const { tombstone_id: _id, set_root: _root, ...chainCore } = chain; void _id; void _root;
      const changedChainCore = { ...chainCore, target_manifest_digest: targetManifest,
        scope_digest: scopeDigest, payload_digest: payloadDigest };
      const setRoot = memoryEffectDigest("tombstone_chain", changedChainCore);
      const changedChain = { ...changedChainCore, tombstone_id: `memtomb:v1:${setRoot.slice(7)}`, set_root: setRoot };
      const baseSpec = specification(base);
      return createMemoryEffectWriteRequest({ ...baseSpec, target_manifest_digest: targetManifest, targets: [target],
        scope, scope_digest: scopeDigest, tombstone_high_water: { sequence: changedChain.sequence, set_root: setRoot },
        tombstone_chain_delta: [changedChain], payload }, {
        principal_id: "principal:owner", not_before: base.created_at,
        nonce: withReceipt ? "nonce:external-receipt" : "nonce:external-missing",
        signing_key_id: "jarvis:fixture",
      }, privateKey);
    };
    expect(parseMemoryEffectWriteRequest(build(true), { now: new Date("2026-08-31T00:00:01.000Z"),
      delegationKeys: new Map([["jarvis:fixture", publicKey]]),
      externalReceiptKeys: new Map([["external:fixture", createPublicKey(externalPrivate)]]) })).toBeDefined();
    expect(parseMemoryEffectWriteRequest(build(false), { now: new Date("2026-08-31T00:00:01.000Z"),
      delegationKeys: new Map([["jarvis:fixture", publicKey]]),
      externalReceiptKeys: new Map([["external:fixture", createPublicKey(externalPrivate)]]) })).toBeUndefined();
  });

  it("matches the cross-process post-forget read fence", () => {
    const fence = createMemoryReadFence({ provider_instance_id: "provider:fixture", purpose: "memory_read",
      operation: "read", tombstone_sequence: 2,
      tombstone_set_root: "sha256:908cd03d8a17024d3aae83927dc2053492a605ee16b02e1987d8aee7c8b76dfd",
      issued_at: "2026-08-31T00:00:01.000Z", not_before: "2026-08-31T00:00:01.000Z",
      expires_at: "2026-08-31T00:01:01.000Z", nonce: `memfence-nonce:${"a".repeat(64)}`,
      signing_key_id: "jarvis:fixture" }, privateKey);
    expect(fence).toMatchObject({
      fence_id: "memfence:v1:0f9d63c623a72abe72f1c717bf9136f04fc2a41ba1be44f8c2c395d0e8c70fea",
      fence_digest: "sha256:0f9d63c623a72abe72f1c717bf9136f04fc2a41ba1be44f8c2c395d0e8c70fea",
      signature: "sQbb--0cXjA20TfC0_GeZVaeL7gkBVHPcAdgDb2m_5xe2M0gY8H33WiUVf2rXklWkz4ktqn4T-64BGisIhk7Bw",
    });
  });

  it("freezes delegation revocation identity and rejects signature mutation", () => {
    const revocation = contract.vectors.delegation_revocation;
    const { revocation_id, revocation_digest, ...body } = revocation ?? {};
    expect(memoryEffectDigest("delegation_revocation", body)).toBe("sha256:d83f74797606be5d7fd8c2e243b710df2b8588097d8784080d9a58178e4167e9");
    expect(revocation_digest).toBe("sha256:d83f74797606be5d7fd8c2e243b710df2b8588097d8784080d9a58178e4167e9");
    expect(revocation_id).toBe("memdeleg-revoke:v1:d83f74797606be5d7fd8c2e243b710df2b8588097d8784080d9a58178e4167e9");
    const value = request("forget");
    const delegation = { ...value.delegation, signature: `${value.delegation.signature.slice(0, -1)}A` } as MemoryEffectDelegationV2;
    expect(parseMemoryEffectWriteRequest({ ...value, delegation }, {
      now: new Date("2026-08-31T00:00:01.000Z"), delegationKeys: new Map([["jarvis:fixture", publicKey]]),
    })).toBeUndefined();
  });
});
