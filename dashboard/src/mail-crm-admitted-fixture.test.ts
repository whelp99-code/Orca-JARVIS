import { describe, expect, it } from "vitest";
import { ADMITTED_MR_PROJECTION, readAdmittedMailCrmFixture } from "./mail-crm-admitted-fixture.js";

describe("Root-admitted recorded MR projection", () => {
  it("retains the Mail producer's exact selected machine fields", () => {
    const evidence = readAdmittedMailCrmFixture();
    expect(evidence).toEqual(ADMITTED_MR_PROJECTION);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence.root_monitor).not.toBe(evidence.producer_monitor);
  });
  it.each([
    ["source_digest", "a".repeat(64)],
    ["receive_audit_hash", "b".repeat(64)],
    ["mapping_state_hash", "c".repeat(64)],
    ["source_locator", "foreign-message"],
    ["mapping_authority", "live-human"],
    ["mapping_command", "business.reconcileNormalized"],
    ["mapping_version", 8],
    ["receive_version", 6],
    ["proof_level", "live"],
  ])("refuses a changed %s instead of retaining admitted status", (field, value) => {
    expect(() => readAdmittedMailCrmFixture({ ...ADMITTED_MR_PROJECTION, [field]: value })).toThrow();
  });
  it("refuses added self-grant and approval fields", () => {
    expect(() => readAdmittedMailCrmFixture({ ...ADMITTED_MR_PROJECTION, approved: true })).toThrow();
    expect(() => readAdmittedMailCrmFixture({ ...ADMITTED_MR_PROJECTION, authority: { principal: "owner" } })).toThrow();
  });
});
