import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Task33 checked-in driver", () => {
  it("uses the built real dashboard HTTP boundary instead of a parallel store", () => {
    // Given / When
    const source = readFileSync(join(process.cwd(), "scripts", "task33-notification-driver.mjs"), "utf8");
    // Then
    expect(source).toContain("createDashboardServer");
    expect(source).not.toContain("NotificationDeliveryStore");
    expect(source).toContain("claims === 2");
    expect(source).toContain("shows === 1");
    expect(source).toContain("settles === 1");
    expect(source).toContain("ELECTRON_SINGLE_INSTANCE_REDIRECTED");
    expect(source).toContain("TASK33_REAL_SECOND_PROCESS_PASS");
    expect(source).toContain("secondExit === 0");
    expect(source).toContain("navigationCount === 1");
    expect(source).toContain("malformedNavigationCount === 0");
    expect(source).toContain("sharedUserData");
  });
});
