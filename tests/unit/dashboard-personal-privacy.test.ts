import { describe, expect, it } from "vitest";
import { assertSafeIdentifier, sanitizePersonalProjection } from "../../src/dashboard/personal-privacy.js";

describe("personal dashboard projection privacy", () => {
  it("redacts actual private metadata throughout the whole output", () => {
    // Given
    const value = { item: { title: "credential: hunter2", public_key_cose: "bytes", path: "/home/jm/private",
      note: "WebAuthn credential", signing: "signing key", passkey: "passkey material" } };
    // When
    const output = sanitizePersonalProjection(value);
    // Then
    expect(JSON.stringify(output)).not.toContain("hunter2");
    expect(JSON.stringify(output)).not.toContain("/home/");
    expect(JSON.stringify(output)).not.toContain("WebAuthn");
    expect(JSON.stringify(output)).not.toContain("signing key");
  });

  it("preserves benign lexical near misses and punctuation", () => {
    // Given
    const value = { title: "Public keynote", notes: ["passkeynote", "webauthnote", "public-keynote", "quotes #tag $20"] };
    // When
    const output = sanitizePersonalProjection(value);
    // Then
    expect(output).toEqual(value);
  });

  it("rejects private path identifiers while preserving benign identifiers", () => {
    // Given / When / Then
    expect(() => assertSafeIdentifier("/home/jm/private")).toThrowError("PERSONAL_PROJECTION_PRIVATE");
    expect(() => assertSafeIdentifier("safe-resource-id")).not.toThrow();
  });
});
