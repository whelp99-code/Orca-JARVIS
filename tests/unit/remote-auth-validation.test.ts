import { describe, expect, it } from "vitest";
import { parseAssertionCredential, parseDecisionBody, parseVerifyBody } from "../../src/remote-approval-parse.js";
import { RemoteApprovalError } from "../../src/remote-approval-errors.js";
import { evaluateBackup, evaluateCounter } from "../../src/remote-approval-backup.js";
import { base64url } from "../../src/receipt.js";

const handle = base64url(Buffer.alloc(32, 7));
const valid = {
  id: "abc",
  rawId: "abc",
  type: "public-key",
  response: {
    clientDataJSON: base64url(Buffer.from("{}")),
    authenticatorData: base64url(Buffer.alloc(37)),
    signature: base64url(Buffer.alloc(64)),
    userHandle: handle,
  },
  authenticatorAttachment: null,
  clientExtensionResults: {},
};

describe("remote assertion closed parsing", () => {
  it("rejects extra, prototype, and missing keys", () => {
    expect(() => parseAssertionCredential({ ...valid, extra: true })).toThrow(RemoteApprovalError);
    expect(() => parseAssertionCredential({ ...valid, userHandle: handle })).toThrow(RemoteApprovalError);
    expect(() => parseDecisionBody({ schema_version: 1, decision: "approve", extra: 1 })).toThrow(RemoteApprovalError);
    expect(() => parseVerifyBody({ schema_version: 1 })).toThrow(RemoteApprovalError);
  });

  it("rejects a registration userHandle echo on assertion-shaped extra fields", () => {
    const response = { ...valid.response, userHandle: handle, extra: true };
    expect(() => parseAssertionCredential({ ...valid, response })).toThrow(RemoteApprovalError);
  });
});

describe("backup and counter matrices", () => {
  it("accepts stored 0/0 returning 0/0 and rejects BE=0 BS=1", () => {
    expect(evaluateBackup({ eligible: 0, state: 0 }, { eligible: 0, state: 0 }).kind).toBe("accept");
    expect(evaluateBackup({ eligible: 0, state: 0 }, { eligible: 0, state: 1 })).toEqual({ kind: "reject", reason: "BACKUP_FLAGS_INVALID" });
  });

  it("updates BS only when stored BE is 1", () => {
    expect(evaluateBackup({ eligible: 1, state: 0 }, { eligible: 1, state: 1 })).toEqual({
      kind: "accept", next: { eligible: 1, state: 1 },
    });
    expect(evaluateBackup({ eligible: 1, state: 1 }, { eligible: 1, state: 0 })).toEqual({
      kind: "accept", next: { eligible: 1, state: 0 },
    });
  });

  it("accepts zero-to-zero counters and rejects nonincreasing monotonic counters", () => {
    expect(evaluateCounter(0, 0)).toMatchObject({ kind: "accept", mode: "zero", disposition: "zero" });
    expect(evaluateCounter(0, 4)).toMatchObject({ kind: "accept", mode: "monotonic", next: 4 });
    expect(evaluateCounter(5, 5)).toMatchObject({ kind: "reject", disposition: "nonincreasing" });
    expect(evaluateCounter(5, 4)).toMatchObject({ kind: "reject", disposition: "nonincreasing" });
  });
});
