import { describe, expect, it } from "vitest";
import { isTransientOrcaReadFailure, parseOrcaReadPayload } from "../../src/orca-read-envelope.js";
import { parseSecondBrainStrictJson } from "../../src/second-brain-strict-json.js";
import { JarvisError } from "../../src/db.js";

export const failures = [
  ["runtime_unavailable", "ORCA_CLI_UNAVAILABLE", true],
  ["runtime_timeout", "ORCA_CLI_TIMEOUT", true],
  ["terminal_handle_stale", "ORCA_TERMINAL_STALE", false],
  ["permission_denied", "ORCA_PERMISSION_DENIED", false],
  ["invalid_runtime_response", "ORCA_CLI_SCHEMA_INVALID", false],
  ["future_denial", "ORCA_CLI_REJECTED", false],
] as const;

describe("Orca read envelope", () => {
  it.each(failures)("classifies only verified %s without exposing error prose", (code, expected, transient) => {
    let failure: unknown;
    try { parseOrcaReadPayload(JSON.stringify({ ok: false, error: { code, message: "secret-detail" } })); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: expected, message: expected });
    expect(isTransientOrcaReadFailure(failure)).toBe(transient);
  });

  it.each([
    '{"ok":false,"ok":true,"result":{}}',
    '{"ok":false,"\\u006fk":true,"result":{}}',
    '{"ok":true,"result":{"terminals":[],"terminals":[]}}',
    '{"ok":false,"error":{"code":"permission_denied","code":"runtime_timeout","message":"x"}}',
    '{"ok":true,"result":{"value":1e999}}',
  ])("rejects ambiguous JSON before classifying success: %s", input => {
    expect(() => parseOrcaReadPayload(input)).toThrow("ORCA_CLI_JSON_INVALID");
  });

  it.each([
    '{"ok":false,"__proto__":{"error":{"code":"runtime_unavailable","message":"x"}}}',
    '{"ok":false,"error":{"__proto__":{"code":"runtime_timeout","message":"x"}}}',
    '{"ok":true,"result":{},"__proto__":null}',
    '{"ok":true,"result":{},"error":{"code":"runtime_timeout","message":"x"}}',
    '{"ok":false}', '{"ok":true,"version":2,"result":{}}',
  ])("rejects invalid schema rather than treating it as an outage: %s", input => {
    expect(() => parseOrcaReadPayload(input)).toThrow("ORCA_CLI_SCHEMA_INVALID");
  });

  it("accepts a bounded large terminal list without raising Second Brain's existing node limit", () => {
    const input = JSON.stringify({ ok: true, result: { terminals: Array.from({ length: 1000 }, (_, id) => ({
      handle: `term_${id}`, ptyId: `pty_${id}`, incarnationId: `inc_${id}`, connected: true,
      worktreeId: "worktree", title: null, preview: null, lastOutputAt: null,
    })) } });
    expect((parseOrcaReadPayload(input).terminals as unknown[]).length).toBe(1000);
    expect(parseSecondBrainStrictJson(input)).toBeUndefined();
    expect(() => parseOrcaReadPayload(" ".repeat(1_000_001))).toThrow("ORCA_CLI_OUTPUT_LIMIT");
    expect(isTransientOrcaReadFailure(new JarvisError("ORCA_CLI_FAILED"))).toBe(false);
  });
});
