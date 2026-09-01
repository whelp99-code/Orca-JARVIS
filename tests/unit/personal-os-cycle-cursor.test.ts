import { describe, expect, it } from "vitest";
import { applyCycleId } from "../../src/personal-os-cycle-cursor.js";

describe("personal-OS staged cycle cursor", () => {
  it("applies the next id and refuses a gap", () => {
    // Given last_completed=0
    // When applying 1 then 3
    const first = applyCycleId(0, 1);
    const gap = applyCycleId(1, 3);

    // Then
    expect(first).toEqual({ kind: "applied", id: 1 });
    expect(gap).toEqual({ kind: "rejected", id: 3, last_completed: 1 });
  });

  it("reports a replay as duplicate without advancing", () => {
    // Given last_completed=4
    // When the same id is requested again
    const replay = applyCycleId(4, 4);

    // Then
    expect(replay).toEqual({ kind: "duplicate", id: 4 });
  });
});
