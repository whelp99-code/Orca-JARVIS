import { describe, expect, it } from "vitest";
import { elapsedDays, formatReadableDate, formatWon } from "./finance-readable-format.js";

describe("finance readable formatting", () => {
  it("formats source dates in Korean month/day/weekday form", () => {
    expect(formatReadableDate("2026-10-01")).toBe("10/1(목)");
    expect(formatReadableDate("not-a-date")).toBe("확인 필요");
  });

  it("formats integer won amounts without losing large integer precision", () => {
    expect(formatWon(1250000)).toBe("₩1,250,000");
    expect(formatWon("9007199254740993")).toBe("₩9,007,199,254,740,993");
    expect(formatWon(null)).toBe("확인 필요");
    expect(formatWon(1.5)).toBe("확인 필요");
  });

  it("measures elapsed whole days and leaves invalid or future dates unknown", () => {
    expect(elapsedDays("2026-10-04T00:00:00.000Z", "2026-10-09T12:00:00.000Z")).toBe(5);
    expect(elapsedDays("2026-10-10T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).toBeUndefined();
  });
});
