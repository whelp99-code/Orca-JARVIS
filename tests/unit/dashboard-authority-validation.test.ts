import { describe, expect, it } from "vitest";
import {
  parseAuthorityDecision,
  parseCancelRequest,
  parseExecuteRequest,
  parseRetryRequest,
} from "../../src/dashboard/authority-validation.js";

const receipt = {
  schema_version: 1,
  receipt_id: "receipt-1",
  request_id: "req-1",
  decision: "approve",
  command_digest: `sha256:${"b".repeat(64)}`,
  signer_principal_id: "operator",
  authenticated_session_id: "session-1",
  key_id: "key-1",
  algorithm: "Ed25519",
  issued_at: "2026-08-09T06:00:00.000Z",
  not_before: "2026-08-09T06:00:00.000Z",
  expires_at: "2026-08-09T06:10:00.000Z",
  nonce: "nonce-1",
  max_uses: 1,
  status: "issued",
  signature: "b".repeat(86),
} as const;

describe("dashboard authority request parsers", () => {
  it("requires a receipt before generic decision parse", () => {
    expect(() => parseAuthorityDecision({ schema_version: 1 })).toThrow(
      expect.objectContaining({ code: "AUTHORITY_RECEIPT_REQUIRED" }),
    );
    expect(() => parseAuthorityDecision({ schema_version: 1, receipt, extra: true })).toThrow(
      expect.objectContaining({ code: "RECEIPT_DECISION_INVALID" }),
    );
  });

  it("accepts an exact execute envelope and rejects extra keys", () => {
    expect(parseExecuteRequest({ schema_version: 1 })).toEqual({ schema_version: 1 });
    expect(() => parseExecuteRequest({ schema_version: 1, extra: true })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("accepts exact cancel and retry envelopes at identifier and reason limits", () => {
    const cancel = {
      schema_version: 1,
      request_id: "x".repeat(128),
      nonce: "y".repeat(128),
      run_id: "z".repeat(128),
      reason: "r".repeat(512),
    };
    expect(parseCancelRequest(cancel)).toEqual(cancel);
    expect(parseRetryRequest({ schema_version: 1, request_id: cancel.request_id, nonce: cancel.nonce })).toEqual({
      schema_version: 1,
      request_id: cancel.request_id,
      nonce: cancel.nonce,
    });
  });

  it("rejects non-NFC identifiers and overlong cancel reasons", () => {
    const base = { schema_version: 1, request_id: "req-1", nonce: "nonce-1", run_id: "run-1", reason: "stop" };
    expect(() => parseCancelRequest({ ...base, request_id: "e\u0301" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => parseCancelRequest({ ...base, reason: "r".repeat(513) })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => parseRetryRequest({ schema_version: 1, request_id: "e\u0301", nonce: "nonce-1" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});
