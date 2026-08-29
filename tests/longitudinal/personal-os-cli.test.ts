import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = new URL("../../scripts/personal-os-eval.mjs", import.meta.url).pathname;
const run = (args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", env,
});

describe("Task 19 built CLI surface", () => {
  it("shows help without evaluating a corpus", () => {
    // Given: the built evaluator CLI
    // When: help is requested
    const result = run(["--help"]);

    // Then: it exits cleanly with machine-relevant options and no JSON result
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--fixture");
    expect(result.stdout).not.toContain('"schema_version"');
    expect(result.stderr).toBe("");
  });

  it("emits byte-identical happy JSON across timezone and locale settings", () => {
    // Given: two process environments with different presentation settings
    const utc = run([], { ...process.env, TZ: "UTC", LANG: "C" });
    const pacific = run([], { ...process.env, TZ: "Pacific/Honolulu", LANG: "en_US.UTF-8" });

    // When / Then: canonical stdout and passing exits are identical
    expect(utc.status).toBe(0);
    expect(pacific.status).toBe(0);
    expect(utc.stdout).toBe(pacific.stdout);
    expect(utc.stdout).toContain('"verdict":"pass"');
    expect(utc.stderr).toBe("");
  });

  it("exits nonzero with the exact failing threshold reason", () => {
    // Given: the known valid failing-threshold corpus
    // When: it is evaluated
    const result = run(["--fixture", "failing-recall.json"]);

    // Then: stdout remains one full-benchmark result and identifies quality plus recall thresholds
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"failed_reason_codes":["TASK_QUALITY_BELOW_THRESHOLD","MEMORY_RECALL_BELOW_THRESHOLD"]');
    expect(result.stderr).toBe("");
  });

  it("fails typed with empty stdout for malformed and traversal inputs", () => {
    // Given: malformed bytes and an escaping fixture name
    // When: each boundary is invoked
    const malformed = run(["--fixture", "malformed.json"]);
    const traversal = run(["--fixture", "../happy.json"]);

    // Then: neither creates an output artifact or partial stdout result
    expect(malformed).toMatchObject({ status: 2, stdout: "", stderr: '{"code":"PERSONAL_OS_FIXTURE_READ_INVALID"}\n' });
    expect(traversal).toMatchObject({ status: 2, stdout: "", stderr: '{"code":"PERSONAL_OS_FIXTURE_PATH_INVALID"}\n' });
  });
});
