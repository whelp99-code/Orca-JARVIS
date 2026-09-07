import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Task33 driver source contract", () => {
  it("uses the built real dashboard HTTP boundary instead of a parallel store", () => {
    // Given / When
    const source = readFileSync(join(process.cwd(), "scripts", "task33-notification-driver.mjs"), "utf8");
    // Then
    expect(source).toContain("createDashboardServer");
    expect(source).toContain("packageTask33ElectronApp");
    expect(source).not.toContain("NotificationDeliveryStore");
    expect(source).toContain("claims === 2");
    expect(source).toContain("shows === 1");
    expect(source).toContain("settles === 1");
    expect(source).toContain("ELECTRON_SINGLE_INSTANCE_REDIRECTED");
    expect(source).toContain("TASK33_REAL_SECOND_PROCESS_PASS");
    expect(source).toContain("secondExit === 0");
    expect(source).toContain("observationReceipt"); expect(source).toContain("receiptDelta");
    expect(source).toContain("malformedDelta.focus !== 0"); expect(source).toContain("sharedUserData");
    expect(source).not.toContain("[\"--help\", \"jarvis://evil/today\"]");
    expect(source).not.toContain("const malformedFocusCount = 0");
  });

  it("parses second-instance URL before handing off any window effect", () => {
    // Given / When
    const source = readFileSync(join(process.cwd(), "scripts", "lib", "electron-main-source.mjs"), "utf8");
    const start = source.indexOf("async function handleSecondInstance");
    const end = source.indexOf("function focus()", start); const handler = source.slice(start, end);
    // Then
    expect(start).toBeGreaterThan(0); expect(handler).toContain("value === undefined");
    expect(handler).toContain("parseJarvisDeepLink(value)");
    expect(handler.indexOf("parseJarvisDeepLink(value)")).toBeLessThan(handler.indexOf("pendingLink = value"));
    expect(handler).not.toContain("focus()"); expect(handler).toContain("TASK33_OBSERVE_INVALID_SECOND");
  });
});
