import { describe, expect, it } from "vitest";
import { assertSafeIdentifier, sanitizePersonalProjection } from "../../src/dashboard/personal-privacy.js";

describe("personal dashboard projection privacy", () => {
  it("redacts private metadata throughout the whole output", () => {
    // Given
    const value = { item: { title: "credential: hunter2", public_key_cose: "bytes", path: "/home/jm/private" } };
    // When
    const output = sanitizePersonalProjection(value);
    // Then
    expect(JSON.stringify(output)).toBe(JSON.stringify({ item: { title: "[REDACTED]", public_key_cose: "[REDACTED]", path: "[REDACTED]" } }));
  });

  it("rejects private path and accessor-hostile identifiers", () => {
    // Given / When / Then
    expect(() => assertSafeIdentifier("/home/jm/private")).toThrowError("PERSONAL_PROJECTION_PRIVATE");
    expect(() => assertSafeIdentifier("safe-resource-id")).not.toThrow();
  });
});
