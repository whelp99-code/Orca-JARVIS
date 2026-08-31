import { describe, expect, it } from "vitest";
import { parseNotificationClaimInput, parseNotificationSettleInput } from "../../src/notification-delivery-input.js";

describe("notification delivery input", () => {
  it("parses the closed claim and settlement variants", () => {
    // Given
    const claim = { schema_version: 1 };
    const delivered = { schema_version: 1, outcome: "delivered" };
    const failed = { schema_version: 1, outcome: "failed", failure_code: "NOTIFICATION_SHOW_FAILED" };
    // When / Then
    expect(parseNotificationClaimInput(claim)).toEqual(claim);
    expect(parseNotificationSettleInput(delivered)).toEqual(delivered);
    expect(parseNotificationSettleInput(failed)).toEqual(failed);
  });

  it("rejects unknown fields, wrong variants, and hostile prototypes", () => {
    // Given
    const hostile = Object.create({ schema_version: 1 });
    const invalid = [hostile, { schema_version: 1, extra: true }, { schema_version: 2 },
      { schema_version: 1, outcome: "failed" }, { schema_version: 1, outcome: "delivered", failure_code: "x" }];
    // When / Then
    for (const value of invalid) expect(() => parseNotificationSettleInput(value))
      .toThrowError(expect.objectContaining({ code: "NOTIFICATION_DELIVERY_INVALID" }));
  });
});
