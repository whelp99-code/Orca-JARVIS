import { describe, expect, it } from "vitest";
import { encodeRecommendationDeepLink, parseJarvisDeepLink } from "../../scripts/lib/electron-deep-link.mjs";

describe("Electron private deep links", () => {
  it("round trips Today and recommendation links", () => {
    // Given
    const recommendation = "rec:pos:v1:decision-1";
    // When / Then
    expect(parseJarvisDeepLink("jarvis://open/today")).toEqual({ kind: "today" });
    expect(parseJarvisDeepLink(encodeRecommendationDeepLink(recommendation, 3)))
      .toEqual({ kind: "recommendation", recommendationId: recommendation, rank: 3 });
  });

  it("rejects all routes outside the closed grammar", () => {
    // Given
    const invalid = ["https://open/today", "jarvis://evil/today", "jarvis://open/recommendation?id=bad&rank=0",
      "jarvis://open/today?x=1", "jarvis://open/recommendation?id=cmVj&rank=01", "jarvis://open/today#x"];
    // When / Then
    for (const value of invalid) expect(() => parseJarvisDeepLink(value))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_DEEP_LINK_INVALID" }));
  });
});
