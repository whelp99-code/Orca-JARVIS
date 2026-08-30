import { describe, expect, it } from "vitest";
import { PersonalCursorCodec, PersonalCursorError } from "../../src/dashboard/personal-cursor.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const codec = () => new PersonalCursorCodec(Buffer.alloc(32, 7));

describe("personal dashboard cursor", () => {
  it("round trips when the resource and page budget match", () => {
    // Given
    const value = codec().encode({ resource: "daily-runs", limit: 20, total: 21,
      anchor: ["2026-08-30T11:00:00.000Z", "run-1"], issued_at: now.toISOString() });
    // When
    const decoded = codec().decode(value, "daily-runs", 20, now);
    // Then
    expect(decoded.anchor).toEqual(["2026-08-30T11:00:00.000Z", "run-1"]);
  });

  it("rejects a tampered, foreign, stale, or differently-budgeted cursor", () => {
    // Given
    const value = codec().encode({ resource: "daily-runs", limit: 20, total: 21,
      anchor: ["time", "run-1"], issued_at: now.toISOString() });
    // When / Then
    expect(() => codec().decode(`${value}x`, "daily-runs", 20, now)).toThrow(PersonalCursorError);
    expect(() => codec().decode(value, "source-health", 20, now)).toThrow(PersonalCursorError);
    expect(() => codec().decode(value, "daily-runs", 21, now)).toThrow(PersonalCursorError);
    expect(() => codec().decode(value, "daily-runs", 20, new Date(now.getTime() + 300_001))).toThrow(PersonalCursorError);
  });
});
