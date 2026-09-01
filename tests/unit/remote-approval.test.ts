import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import {
  bindingChallenge,
  gatewaySessionDigest,
  hmacHex,
  ingressMac,
  remoteReceiptId,
  remoteReceiptNonce,
  sha256Prefixed,
} from "../../src/remote-approval-crypto.js";
import {
  BINDING_DOMAIN,
  ENVELOPE_DOMAIN,
  ENVELOPE_VECTOR,
  FIXTURE_INGRESS_KEY,
  FROZEN_VECTORS,
  RECEIPT_ID_DOMAIN,
  RECEIPT_ID_VECTOR,
  RECEIPT_NONCE_DOMAIN,
  RECEIPT_NONCE_VECTOR,
  SESSION_DOMAIN,
  type RemoteApprovalBindingV1,
} from "../../src/remote-approval-types.js";
import { verifyCommandApproval } from "../../src/control-plane.js";

describe("remote approval domain-separated vectors", () => {
  it("computes the frozen session digest when the fixture key and phone session preimage are used", () => {
    const digest = gatewaySessionDigest(FIXTURE_INGRESS_KEY, "phone-session-digest:fixture");
    expect(digest).toBe(`hmac-sha256:${FROZEN_VECTORS.session}`);
  });

  it("computes the frozen envelope mac when the canonical seven-field object is hashed", () => {
    expect(ingressMac(FIXTURE_INGRESS_KEY, ENVELOPE_VECTOR)).toBe(FROZEN_VECTORS.envelope);
  });

  it("computes the frozen receipt id and nonce when the canonical objects are hashed", () => {
    expect(remoteReceiptId(RECEIPT_ID_VECTOR)).toBe(`remote-receipt:${FROZEN_VECTORS.receipt_id}`);
    expect(remoteReceiptNonce(RECEIPT_NONCE_VECTOR)).toBe(`remote-approval:${FROZEN_VECTORS.receipt_nonce}`);
  });

  it("changes the envelope mac when any canonical field mutates", () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      value => { value.method = "GET"; },
      value => { value.path = "/api/v1/remote-approvals/other/options"; },
      value => { value.schema_version = 2; },
      value => { value.nonce = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
      value => { value.issued_at = "2026-08-31T00:00:00.001Z"; },
      value => { value.body_digest = "sha256:2111111111111111111111111111111111111111111111111111111111111111"; },
      value => { value.session_digest = "hmac-sha256:3222222222222222222222222222222222222222222222222222222222222222"; },
    ];
    for (const mutate of mutations) {
      const value = { ...ENVELOPE_VECTOR };
      mutate(value);
      expect(ingressMac(FIXTURE_INGRESS_KEY, value)).not.toBe(FROZEN_VECTORS.envelope);
    }
  });

  it("keeps session, envelope, receipt-id, and receipt-nonce macs unequal across protocol domains", () => {
    const payload = canonicalize(ENVELOPE_VECTOR);
    const session = hmacHex(FIXTURE_INGRESS_KEY, SESSION_DOMAIN, payload);
    const envelope = hmacHex(FIXTURE_INGRESS_KEY, ENVELOPE_DOMAIN, payload);
    const receiptId = hmacHex(FIXTURE_INGRESS_KEY, RECEIPT_ID_DOMAIN, payload);
    const receiptNonce = hmacHex(FIXTURE_INGRESS_KEY, RECEIPT_NONCE_DOMAIN, payload);
    const unique = new Set([session, envelope, receiptId, receiptNonce]);
    expect(unique.size).toBe(4);
  });

  it("does not treat a session digest as a command-approval signature", () => {
    const session = gatewaySessionDigest(FIXTURE_INGRESS_KEY, "phone-session-digest:fixture");
    expect(session.startsWith("hmac-sha256:")).toBe(true);
    expect(verifyCommandApproval({
      schema_version: 1,
      receipt_id: "session-is-not-a-receipt",
      request_id: "request-fixture",
      decision: "approve",
      command_digest: sha256Prefixed("no"),
      signer_principal_id: "test-operator",
      authenticated_session_id: session,
      key_id: "decision-test",
      algorithm: "Ed25519",
      issued_at: "2026-08-31T00:00:00.000Z",
      not_before: "2026-08-31T00:00:00.000Z",
      expires_at: "2026-08-31T00:05:00.000Z",
      nonce: "n",
      max_uses: 1,
      status: "issued",
      signature: session.slice("hmac-sha256:".length),
    }, "not-a-key", new Date("2026-08-31T00:01:00.000Z"))).toBe(false);
  });

  it("binds a discoverable challenge without a credential id when the canonical binding is hashed", () => {
    const binding: RemoteApprovalBindingV1 = {
      schema_version: 1,
      challenge_id: "challenge-fixture",
      request_id: "request-fixture",
      decision: "approve",
      command_digest: sha256Prefixed("command"),
      action: "workflow.start",
      action_level: 2,
      target_digest: sha256Prefixed("target"),
      args_digest: sha256Prefixed("args"),
      request_nonce_digest: sha256Prefixed("nonce"),
      remote_principal_id: "principal-fixture",
      user_handle_digest: sha256Prefixed("handle"),
      gateway_owner_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gateway_session_digest: "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      origin: "https://jarvis-fixture.example.invalid",
      rp_id: "jarvis-fixture.example.invalid",
      issued_at: "2026-08-31T00:00:00.000Z",
      expires_at: "2026-08-31T00:05:00.000Z",
      challenge_nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(bindingChallenge(binding).length).toBeGreaterThan(20);
    expect(JSON.stringify(binding).includes("credential_id")).toBe(false);
    expect(hmacHex(FIXTURE_INGRESS_KEY, BINDING_DOMAIN, canonicalize(binding)).length).toBe(64);
  });
});
