import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "task33-mac-native-qa.mjs");
describe("Task33 Mac native QA driver", () => {
  it("has safe help and Linux platform refusal without authority effects", () => {
    // Given / When
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    const refused = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env,
      JARVIS_DB: "/forbidden", JARVIS_AUTHORITY_URL: "http://127.0.0.1:1" } });
    // Then
    expect(help.status).toBe(0); expect(help.stdout).toContain("TASK33_MAC_NATIVE_QA_HELP");
    expect(refused.status).toBe(2); expect(refused.stderr).toContain("TASK33_MAC_NATIVE_BLOCKED_PLATFORM");
    expect(refused.stdout).not.toContain("TASK33_MAC_NATIVE_PASS");
  });
});
