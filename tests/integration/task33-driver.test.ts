import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTestProcess } from "../../scripts/lib/test-process.mjs";

describe("Task33 checked-in driver", () => {
  it("runs malformed second process through single-instance handling with measured zero effects", async () => {
    // Given
    const script = join(process.cwd(), "scripts", "task33-notification-driver.mjs");
    if (process.platform === "linux" && !process.env.DISPLAY?.trim()) throw new Error("USE_NPM_RUN_TEST_GUI");
    // When
    const result = await runTestProcess(process.execPath, [script], { timeoutMs: 60000, forward: false });
    // Then
    expect(result, result.output).toMatchObject({ code: 0, timedOut: false });
    expect(result.output).toContain("TASK33_REAL_MALFORMED_SECOND_PASS exit=0 redirected=1 focus=0 navigation=0 resource=0 show=0 settle=0");
  }, 65_000);
});
