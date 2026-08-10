import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyProgressEvidence, parseProgressSignal, progressSignalPayload, verifyProgressSignal } from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import type { ProgressEvidenceInput, ProgressSignal, ProgressSignalKey } from "../../src/index.js";

const now = new Date("2026-08-09T06:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const key: ProgressSignalKey = { key_id: "progress-key", purpose: "progress-signal", provider: "codex", public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), active: true, not_before: "2026-08-09T05:00:00.000Z", expires_at: "2026-08-09T07:00:00.000Z" };
const claudeKey: ProgressSignalKey = { ...key, key_id: "claude-progress-key", provider: "claude" };
const event = (signal: Omit<ProgressSignal, "event_id" | "signature">) => `sha256:${createHash("sha256").update(JSON.stringify(["progress-signal-event/v1", signal.source, signal.provider, signal.terminal_id, signal.incarnation_id, signal.cursor, signal.sequence, signal.state, signal.reason_code, signal.active, signal.observed_at]), "utf8").digest("hex")}`;
function signal(overrides: Partial<ProgressSignal> = {}): ProgressSignal {
  const unsigned = { schema_version: 1 as const, source: "provider_bridge" as const, provider: "codex" as const, terminal_id: "terminal-1", incarnation_id: "incarnation-1", cursor: "42", sequence: "7", state: "running" as const, reason_code: "codex_turn_active" as const, active: true as const, observed_at: "2026-08-09T05:59:00.000Z", key_id: key.key_id, algorithm: "Ed25519" as const, ...overrides };
  const payload = { ...unsigned, event_id: event(unsigned) };
  return { ...payload, signature: sign(null, Buffer.concat([Buffer.from("orca-jarvis/progress-signal/v1\0", "ascii"), Buffer.from(canonicalize(payload), "utf8")]), pair.privateKey).toString("base64url") };
}
function input(overrides: Partial<ProgressEvidenceInput> = {}): ProgressEvidenceInput { return { provider: "codex", terminal_id: "terminal-1", incarnation_id: "incarnation-1", cursor: "42", connected: true, capture_complete: true, observed_at: "2026-08-09T06:00:00.000Z", now, signals: [signal()], trusted_keys: [key], ...overrides }; }
function noncanonicalBase64url(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${alphabet[index ^ 1]!}`;
}

describe("progress signal v1", () => {
  it("parses the literal signal, preserves signed payload order, and verifies Ed25519 SPKI bytes", () => {
    const value = signal();
    expect(parseProgressSignal(value)).toEqual(value);
    expect(Object.keys(progressSignalPayload(value))).toEqual(["schema_version", "source", "provider", "terminal_id", "incarnation_id", "cursor", "sequence", "state", "reason_code", "active", "observed_at", "event_id", "key_id", "algorithm"]);
    expect(verifyProgressSignal(value, key, now)).toBe(true);
  });

  it("rejects malformed signals through the public parser and never throws from verification", () => {
    expect(() => parseProgressSignal({ ...signal(), sequence: "0" })).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INVALID" }));
    expect(() => parseProgressSignal({ ...signal(), event_id: "sha256:bad" })).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INVALID" }));
    expect(verifyProgressSignal({ ...signal(), signature: "=" }, key, now)).toBe(false);
    expect(verifyProgressSignal(signal(), { ...key, public_key_pem: "not pem" }, now)).toBe(false);
    const invalidCalendar = "2026-99-99T99:99:99.999Z";
    expect(() => parseProgressSignal(signal({ observed_at: invalidCalendar }))).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INVALID" }));
    expect(verifyProgressSignal(signal({ observed_at: invalidCalendar }), key, now)).toBe(false);
    expect(() => classifyProgressEvidence(input({ observed_at: invalidCalendar }))).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INPUT_INVALID" }));
  });

  it("requires exact schemas, normalized UTF-8 identifiers, and the inclusive sequence boundary", () => {
    const validMax = signal({ sequence: "9223372036854775807" });
    expect(parseProgressSignal(validMax).sequence).toBe("9223372036854775807");
    for (const value of [
      { ...signal(), extra: "tail prose: DONE, success, exit 0" },
      Object.fromEntries(Object.entries(signal()).filter(([field]) => field !== "signature")),
      { ...signal(), terminal_id: "e\u0301" },
      { ...signal(), terminal_id: "😀".repeat(65) },
      { ...signal(), sequence: "9223372036854775808" }
    ]) expect(() => parseProgressSignal(value)).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INVALID" }));
    expect(parseProgressSignal(signal({ terminal_id: "😀".repeat(64) })).terminal_id).toHaveLength(128);
    expect(() => classifyProgressEvidence({ ...input(), tail: "DONE success tests passed exit 0" } as unknown as ProgressEvidenceInput)).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INPUT_INVALID" }));
  });

  it("rejects noncanonical base64url aliases and every disallowed key binding", () => {
    const value = signal();
    const alias = noncanonicalBase64url(value.signature);
    expect(Buffer.from(alias, "base64url").equals(Buffer.from(value.signature, "base64url"))).toBe(true);
    expect(alias).not.toBe(value.signature);
    expect(verifyProgressSignal({ ...value, signature: alias }, key, now)).toBe(false);
    for (const candidate of [
      { ...key, purpose: "decision" }, { ...key, provider: "claude" }, { ...key, active: false },
      { ...key, not_before: "2026-08-09T06:00:00.001Z" }, { ...key, expires_at: "2026-08-09T05:59:59.999Z" }
    ]) expect(verifyProgressSignal(value, candidate as unknown as ProgressSignalKey, now)).toBe(false);
  });

  it("implements the total gate precedence before any signal result", () => {
    expect(classifyProgressEvidence(input({ capture_complete: false, connected: false })).reason_code).toBe("incomplete_capture");
    expect(classifyProgressEvidence(input({ observed_at: "2026-08-09T05:44:59.999Z", connected: false })).reason_code).toBe("stale_evidence");
    expect(classifyProgressEvidence(input({ connected: false })).reason_code).toBe("terminal_disconnected");
    expect(classifyProgressEvidence(input({ signals: [] })).reason_code).toBe("no_trusted_signal");
    expect(() => classifyProgressEvidence(input({ observed_at: "2026-08-09T06:00:00.001Z" }))).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INPUT_INVALID" }));
    expect(() => classifyProgressEvidence(input({ trusted_keys: [key, key] }))).toThrow(expect.objectContaining({ code: "PROGRESS_SIGNAL_INPUT_INVALID" }));
  });

  it("accepts every provider-specific positive state and reason pair", () => {
    const cases = [
      ["codex", "approval_required", "codex_exec_approval", key], ["codex", "approval_required", "codex_file_change_approval", key], ["codex", "approval_required", "codex_permission_escalation", key],
      ["codex", "needs_input", "codex_user_input_request", key], ["codex", "needs_input", "codex_elicitation", key], ["codex", "verifying", "jarvis_canonical_verify_active", key], ["codex", "running", "codex_turn_active", key], ["codex", "running", "codex_tool_active", key],
      ["claude", "approval_required", "claude_permission_request", claudeKey], ["claude", "approval_required", "claude_plan_approval", claudeKey], ["claude", "needs_input", "claude_user_question", claudeKey], ["claude", "needs_input", "claude_elicitation", claudeKey], ["claude", "verifying", "jarvis_canonical_verify_active", claudeKey], ["claude", "running", "claude_turn_active", claudeKey], ["claude", "running", "claude_tool_active", claudeKey]
    ] as const;
    for (const [provider, state, reason_code, trusted] of cases) {
      const evidence = signal({ provider, state, reason_code, key_id: trusted.key_id });
      expect(classifyProgressEvidence(input({ provider, signals: [evidence], trusted_keys: [trusted] }))).toMatchObject({ state, reason_code });
    }
  });

  it("fails closed for invalid binding and stale evidence, then selects the maximum sequence", () => {
    expect(classifyProgressEvidence(input({ signals: [{ ...signal(), terminal_id: "other" }] })).reason_code).toBe("invalid_signal");
    expect(classifyProgressEvidence(input({ signals: [signal({ observed_at: "2026-08-09T05:44:59.999Z" })] })).reason_code).toBe("stale_evidence");
    expect(classifyProgressEvidence(input({ signals: [signal({ observed_at: "2026-08-09T06:00:00.001Z" })] })).reason_code).toBe("stale_evidence");
    const stale = signal({ observed_at: "2026-08-09T05:44:59.999Z" });
    const invalid = signal({ terminal_id: "other" });
    for (const signals of [[stale, invalid], [invalid, stale]]) expect(classifyProgressEvidence(input({ signals })).reason_code).toBe("invalid_signal");
    const lower = signal({ sequence: "6" });
    const upper = signal({ sequence: "8", state: "needs_input", reason_code: "codex_elicitation" });
    expect(classifyProgressEvidence(input({ signals: [upper, lower] }))).toMatchObject({ state: "needs_input", reason_code: "codex_elicitation", sequence: "8" });
  });

  it("treats an exact maximum replay as stable and a conflicting maximum as ambiguous", () => {
    const value = signal();
    expect(classifyProgressEvidence(input({ signals: [value, value] }))).toMatchObject({ state: "running", sequence: "7" });
    expect(classifyProgressEvidence(input({ signals: [value, signal({ state: "verifying", reason_code: "jarvis_canonical_verify_active" })] })).reason_code).toBe("ambiguous_evidence");
  });
});
