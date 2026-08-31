import { describe, expect, it } from "vitest";
import { projectMacNotificationPayload } from "../../src/notification-delivery-payload.js";
import { DELIVERY_PRIVACY_CANARIES } from "../fixtures/notification-delivery-fixture.js";

describe("mac notification payload", () => {
  it("projects exactly four allowlisted fields and an opaque private link", () => {
    // Given / When
    const payload = projectMacNotificationPayload({ urgency: "critical", preview: "Review the protected decision",
      deepLink: "/recommendations/rec%3Apos%3Av1%3Aone?rank=2" });
    // Then
    expect(Object.keys(payload)).toEqual(["title", "summary", "alert_class", "deep_link"]);
    expect(payload.alert_class).toBe("decision_critical");
    expect(payload.deep_link).toMatch(/^jarvis:\/\/open\/recommendation\?id=[A-Za-z0-9_-]+&rank=2$/u);
  });

  it("rejects all six privacy classes in summary and resource identity before delivery", () => {
    // Given / When / Then
    for (const canary of DELIVERY_PRIVACY_CANARIES) {
      expect(() => projectMacNotificationPayload({ urgency: "action", preview: canary,
        deepLink: "/recommendations/rec%3Apos%3Av1%3Aone?rank=1" }))
        .toThrowError(expect.objectContaining({ code: "NOTIFICATION_DELIVERY_INVALID" }));
      expect(() => projectMacNotificationPayload({ urgency: "action", preview: "Review decision",
        deepLink: `/recommendations/${encodeURIComponent(canary)}?rank=1` }))
        .toThrowError(expect.objectContaining({ code: "NOTIFICATION_DELIVERY_INVALID" }));
    }
  });

  it("rejects secret-bearing, malformed, and oversized projections", () => {
    // Given
    const values = [...DELIVERY_PRIVACY_CANARIES, "x".repeat(161)];
    // When / Then
    for (const preview of values) expect(() => projectMacNotificationPayload({ urgency: "action", preview,
      deepLink: "/recommendations/rec%3Apos%3Av1%3Aone?rank=1" }))
      .toThrowError(expect.objectContaining({ code: "NOTIFICATION_DELIVERY_INVALID" }));
  });
});
