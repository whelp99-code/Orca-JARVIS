import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Task33 checked-in driver", () => {
  it("runs malformed second process through single-instance handling with measured zero effects", async () => {
    // Given
    const child = spawn("xvfb-run", ["-a", process.execPath, join(process.cwd(), "scripts", "task33-notification-driver.mjs")],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
    // When
    const [code] = await once(child, "exit", { signal: AbortSignal.timeout(60_000) });
    // Then
    expect(code).toBe(0);
    expect(output).toContain("TASK33_REAL_MALFORMED_SECOND_PASS exit=0 redirected=1 focus=0 navigation=0 resource=0 show=0 settle=0");
  }, 65_000);

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
