import { describe, expect, it } from "vitest";
import { ADMITTED_MS_PROJECTION, readAdmittedCompanyMemoryFixture } from "./company-memory-admitted-fixture.js";

describe("Root-admitted isolated MS projection", () => {
  it("retains all selected machine fields as immutable recorded evidence", () => {
    const evidence = readAdmittedCompanyMemoryFixture();
    expect(evidence).toEqual(ADMITTED_MS_PROJECTION);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.locator)).toBe(true);
  });
  it.each([
    ["workspace_id", "22345678-1234-4234-8234-123456789abc"],
    ["candidate_id", "mail:v1:foreign"],
    ["request_digest", `sha256:${"a".repeat(64)}`],
    ["content_digest", `sha256:${"b".repeat(64)}`],
    ["admitted_receipt_id", `cmreceipt:v1:${"c".repeat(64)}`],
    ["parser_version", "mail:company-memory:1"],
    ["state", "approved"],
    ["ack", "PENDING"],
    ["ack_version", 1],
    ["proof_level", "live"],
    ["admission_sha256", "d".repeat(64)],
  ])("refuses a changed %s rather than relabeling it as accepted evidence", (field, value) => {
    expect(() => readAdmittedCompanyMemoryFixture({ ...ADMITTED_MS_PROJECTION, [field]: value })).toThrow();
  });
  it("refuses inline source, caller authority and mutable event-kind locators", () => {
    for (const extra of [{ content: "not keys-only" }, { authority: { principal: "owner" } },
      { locator: { graph_id: "original", kind: "mail_work" } }]) {
      expect(() => readAdmittedCompanyMemoryFixture({ ...ADMITTED_MS_PROJECTION, ...extra })).toThrow();
    }
  });
});
