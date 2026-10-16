import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalize } from "../../src/canonical.js";
import { companyApprovalReceiptSchema } from "../../src/company-approver-contract.js";
import { companyCheckpointSchema } from "../../src/company-freshness.js";
import { companyFreshnessRequestDigest, parseCompanyFreshnessEnvelope } from "../../src/company-freshness-envelope.js";
import { companyOtherStorePrefix } from "../../src/company-local-progress.js";

const key = z.object({ test_only_public_key_spki_der_hex: z.string() });
const fixture = z.object({ db_provider_extension: z.object({
  test_only: z.literal(true),
  prefix_rebase: z.object({ observed: companyCheckpointSchema, latest: companyCheckpointSchema, expected_safe: z.boolean() }),
  freshness_outer_vector: z.object({ test_only_key: key, envelope: z.unknown() }),
  policy_auto_vector: z.object({ test_only_key: key, command: z.record(z.string(), z.unknown()),
    receipt: z.object({ signature: z.string(), command_digest: z.string() }).passthrough() }),
}) }).parse(JSON.parse(readFileSync(new URL("../../fixtures/company-approver/company-approver-v2.test-only.json", import.meta.url), "utf8")));

describe("additive company DB provider contract vectors", () => {
  it("verifies the original authority domain and new freshness request digest", () => {
    const vector = fixture.db_provider_extension.freshness_outer_vector;
    const envelope = parseCompanyFreshnessEnvelope(vector.envelope);
    const { signature, ...unsigned } = envelope.authority;
    expect(envelope.authority.request_digest).toBe(companyFreshnessRequestDigest(envelope));
    expect(verify(null, Buffer.from(`second-brain/company-memory-authority/v1\0${canonicalize(unsigned)}`),
      createPublicKey({ key: Buffer.from(vector.test_only_key.test_only_public_key_spki_der_hex, "hex"), format: "der", type: "spki" }),
      Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("keeps the policy receipt separate from human approval and binds its whole command", () => {
    const vector = fixture.db_provider_extension.policy_auto_vector;
    const { signature, ...unsigned } = vector.receipt;
    expect(vector.receipt.command_digest).toBe(`sha256:${createHash("sha256").update(canonicalize(vector.command)).digest("hex")}`);
    expect(verify(null, Buffer.from(`second-brain/company-policy-auto/v1\0${canonicalize(unsigned)}`),
      createPublicKey({ key: Buffer.from(vector.test_only_key.test_only_public_key_spki_der_hex, "hex"), format: "der", type: "spki" }),
      Buffer.from(signature, "base64url"))).toBe(true);
    expect(companyApprovalReceiptSchema.safeParse(vector.receipt).success).toBe(false);
  });

  it("permits only the unchanged own-store retained prefix", () => {
    const vector = fixture.db_provider_extension.prefix_rebase;
    expect(companyOtherStorePrefix(vector.observed, vector.latest)).toBe(vector.expected_safe);
    const corrupt = structuredClone(vector.latest);
    corrupt.stores.jarvis.receipt_sequence++;
    corrupt.stores.jarvis.receipt_root = `sha256:${"a".repeat(64)}`;
    expect(companyOtherStorePrefix(vector.observed, corrupt)).toBe(false);
  });
});
