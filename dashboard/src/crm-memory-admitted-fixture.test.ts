import { describe, expect, it } from "vitest";
import { ADMITTED_RS_PROJECTION, readAdmittedCrmMemoryFixture } from "./crm-memory-admitted-fixture.js";

describe("Root-admitted recorded RS projection", () => {
  it("retains Root's selected fields without coercing native and locator approval", () => {
    const evidence = readAdmittedCrmMemoryFixture();
    expect(evidence).toEqual(ADMITTED_RS_PROJECTION);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence.archive_approved).toBe(false);
    expect(evidence.locator_approved).toBe("false");
  });
  it.each([
    ["source_bytes_sha256", "a".repeat(64)],
    ["request_digest", `sha256:${"b".repeat(64)}`],
    ["receipt_id", `cmreceipt:v1:${"c".repeat(64)}`],
    ["operation", "approve"],
    ["state", "approved"],
    ["ack", "PENDING"],
    ["ack_version", 1],
    ["authority_level", "live"],
    ["archive_authority", "FINANCE_TRUTH"],
    ["archive_approved", true],
    ["locator_approved", false],
    ["proof_level", "live"],
  ])("refuses a changed %s rather than promoting recorded evidence", (field, value) => {
    expect(() => readAdmittedCrmMemoryFixture({ ...ADMITTED_RS_PROJECTION, [field]: value })).toThrow();
  });
  it("refuses inline source or caller authority fields", () => {
    expect(() => readAdmittedCrmMemoryFixture({ ...ADMITTED_RS_PROJECTION, content: "inline source" })).toThrow();
    expect(() => readAdmittedCrmMemoryFixture({ ...ADMITTED_RS_PROJECTION, authority: { principal: "owner" } })).toThrow();
  });
});
