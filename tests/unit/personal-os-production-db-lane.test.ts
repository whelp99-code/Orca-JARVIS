import { describe, expect, it } from "vitest";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { ProductionDatabaseLaneGuard } from "../../src/personal-os-production-db-lane.js";

describe("production database skip lane", () => {
  it("measures zero attempts for isolated paths and increments when a production path is inspected", () => {
    // Given
    const lane = new ProductionDatabaseLaneGuard();

    // When
    lane.inspect("/dev/shm/jarvis-task36-isolated/jarvis.sqlite", "open");
    const skipped = lane.receipt();
    expect(() => lane.inspect("/home/jm/.local/state/orca-jarvis/jarvis.sqlite", "open")).toThrow(PersonalOsError);
    const denied = lane.receipt();

    // Then
    expect(skipped).toEqual({
      schema_version: 1,
      lane: "production-database",
      state: "SKIPPED_NOT_AUTHORIZED",
      open_attempts: 0,
      bytes_read: 0,
      copies_created: 0,
    });
    expect(denied.open_attempts).toBe(1);
    expect(denied.copies_created).toBe(0);
    expect(denied.state).toBe("SKIPPED_NOT_AUTHORIZED");
  });
});
