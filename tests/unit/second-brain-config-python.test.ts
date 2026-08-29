import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSecondBrainConfigWithPython,
  runSecondBrainConfigProcess,
  SECOND_BRAIN_CONFIG_PYTHON,
  SECOND_BRAIN_CONFIG_PYTHON_SCRIPT,
  type SecondBrainConfigProcessRequest,
  type SecondBrainConfigProcessResult,
} from "../../src/second-brain-config-python.js";

const VALID = 'vault_root = "/safe/vault"\n';

describe("bounded Python TOML validation process", () => {
  it("uses fixed isolated invocation with exact stdin and strict sentinel grammar", async () => {
    let request: unknown;
    const result = await parseSecondBrainConfigWithPython(Buffer.from(VALID), async input => {
      request = input;
      return { kind: "completed", code: 0, signal: null, stdout: "VALID\n", stderr: "" };
    });
    expect(result).toBe("valid");
    expect(request).toMatchObject({
      command: SECOND_BRAIN_CONFIG_PYTHON,
      args: ["-I", "-c", SECOND_BRAIN_CONFIG_PYTHON_SCRIPT],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", PYTHONIOENCODING: "utf-8" },
      timeout_ms: 5_000,
      stdout_max_bytes: 32,
      stderr_max_bytes: 1_024,
    });
    const stdin = typeof request === "object" && request !== null ? Reflect.get(request, "stdin") : undefined;
    if (!Buffer.isBuffer(stdin) && !(stdin instanceof Uint8Array)) throw new TypeError("stdin bytes required");
    expect(createHash("sha256").update(stdin).digest("hex")).toBe(
      createHash("sha256").update(VALID).digest("hex"),
    );
  });

  it.each([
    [{ kind: "completed", code: 0, signal: null, stdout: "MALFORMED\n", stderr: "" }, "malformed"],
    [{ kind: "completed", code: 0, signal: null, stdout: "OTHER\n", stderr: "" }, "unavailable"],
    [{ kind: "completed", code: 7, signal: null, stdout: "VALID\n", stderr: "" }, "unavailable"],
    [{ kind: "completed", code: null, signal: "SIGTERM", stdout: "", stderr: "" }, "unavailable"],
    [{ kind: "completed", code: 0, signal: null, stdout: "VALID\n", stderr: "raw" }, "unavailable"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "timeout" }, "unavailable"],
    [{ kind: "oversize" }, "unavailable"],
    [{ kind: "stdin_failure" }, "unavailable"],
  ] satisfies readonly (readonly [SecondBrainConfigProcessResult, "valid" | "malformed" | "unavailable"])[])(
    "maps process outcome %j to %s",
    async (processResult, expected) => {
      await expect(parseSecondBrainConfigWithPython(Buffer.from(VALID), async () => processResult)).resolves.toBe(expected);
    },
  );

  it.each([
    ["missing", processRequest({ command: "/definitely/missing/python" }), "unavailable"],
    ["timeout", processRequest({ args: ["-I", "-c", "import time; time.sleep(60)"], timeout_ms: 20 }), "timeout"],
    ["nonzero", processRequest({ args: ["-I", "-c", "raise SystemExit(7)"] }), "completed"],
    ["stdout-oversize", processRequest({ args: ["-I", "-c", "print('x' * 100)"], stdout_max_bytes: 8 }), "oversize"],
    ["stderr-oversize", processRequest({ args: ["-I", "-c", "import sys; sys.stderr.write('x' * 100)"], stderr_max_bytes: 8 }), "oversize"],
  ])("supervises %s", async (_name, request, expected) => {
    const result = await runSecondBrainConfigProcess(request);
    expect(result.kind).toBe(expected);
    expect(JSON.stringify(result)).not.toMatch(/credential|token|\/safe\/vault/i);
  });
});

function processRequest(
  overrides: Partial<SecondBrainConfigProcessRequest>,
): SecondBrainConfigProcessRequest {
  return {
    command: SECOND_BRAIN_CONFIG_PYTHON,
    args: ["-I", "-c", SECOND_BRAIN_CONFIG_PYTHON_SCRIPT],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", PYTHONIOENCODING: "utf-8" },
    stdin: Buffer.from(VALID),
    timeout_ms: 5_000,
    stdout_max_bytes: 32,
    stderr_max_bytes: 1_024,
    ...overrides,
  };
}
