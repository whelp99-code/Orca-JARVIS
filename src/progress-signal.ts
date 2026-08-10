import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { ProgressClassification, ProgressEvidenceInput, ProgressReasonCode, ProgressSignal, ProgressSignalKey, ProgressSignalProvider, ProgressSignalState } from "./types.js";

const SIGNAL_KEYS = ["schema_version", "source", "provider", "terminal_id", "incarnation_id", "cursor", "sequence", "state", "reason_code", "active", "observed_at", "event_id", "key_id", "algorithm", "signature"] as const;
const KEY_KEYS = ["key_id", "purpose", "provider", "public_key_pem", "active", "not_before", "expires_at"] as const;
const INPUT_KEYS = ["provider", "terminal_id", "incarnation_id", "cursor", "connected", "capture_complete", "observed_at", "now", "signals", "trusted_keys"] as const;
const DOMAIN = Buffer.from("orca-jarvis/progress-signal/v1\0", "ascii");
const MAX_SEQUENCE = 9223372036854775807n;
const FRESHNESS_MS = 15 * 60_000;

const REASONS: Record<ProgressSignalProvider, Record<ProgressSignalState, readonly ProgressReasonCode[]>> = {
  codex: {
    approval_required: ["codex_exec_approval", "codex_file_change_approval", "codex_permission_escalation"],
    needs_input: ["codex_user_input_request", "codex_elicitation"],
    verifying: ["jarvis_canonical_verify_active"],
    stopped: ["jarvis_canonical_final_stopped"],
    running: ["codex_turn_active", "codex_tool_active"]
  },
  claude: {
    approval_required: ["claude_permission_request", "claude_plan_approval"],
    needs_input: ["claude_user_question", "claude_elicitation"],
    verifying: ["jarvis_canonical_verify_active"],
    stopped: ["jarvis_canonical_final_stopped"],
    running: ["claude_turn_active", "claude_tool_active"]
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
};
const isProvider = (value: unknown): value is ProgressSignalProvider => value === "codex" || value === "claude";
const isSignalState = (value: unknown): value is ProgressSignalState => value === "running" || value === "needs_input" || value === "approval_required" || value === "verifying" || value === "stopped";
const isDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");
const isIdentifier = (value: unknown, maxBytes: number): value is string => typeof value === "string" && value === value.normalize("NFC") && value.trim().length > 0 && utf8Length(value) >= 1 && utf8Length(value) <= maxBytes;
const isNullableIdentifier = (value: unknown): value is string | null => value === null || isIdentifier(value, 256);
const isRfc3339Millis = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const isSequence = (value: unknown): value is string => typeof value === "string" && /^(?:[1-9]\d{0,18})$/.test(value) && BigInt(value) <= MAX_SEQUENCE;
const isBase64url = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const isEventId = (value: unknown): value is string => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const invalidSignal = (): never => { throw new JarvisError("PROGRESS_SIGNAL_INVALID"); };
const invalidInput = (): never => { throw new JarvisError("PROGRESS_SIGNAL_INPUT_INVALID"); };

function eventId(signal: Pick<ProgressSignal, "source" | "provider" | "terminal_id" | "incarnation_id" | "cursor" | "sequence" | "state" | "reason_code" | "active" | "observed_at">): string {
  const preimage = JSON.stringify(["progress-signal-event/v1", signal.source, signal.provider, signal.terminal_id, signal.incarnation_id, signal.cursor, signal.sequence, signal.state, signal.reason_code, signal.active, signal.observed_at]);
  return `sha256:${createHash("sha256").update(Buffer.from(preimage, "utf8")).digest("hex")}`;
}

function parseKey(value: unknown): ProgressSignalKey {
  if (!isRecord(value) || !exactKeys(value, KEY_KEYS)) throw new Error("invalid key");
  if (!isIdentifier(value.key_id, 128) || value.purpose !== "progress-signal" || !isProvider(value.provider) || typeof value.public_key_pem !== "string" || value.active !== true || !isRfc3339Millis(value.not_before) || !isRfc3339Millis(value.expires_at)) throw new Error("invalid key");
  if (Date.parse(value.not_before) > Date.parse(value.expires_at)) throw new Error("invalid key");
  return Object.freeze({ key_id: value.key_id, purpose: value.purpose, provider: value.provider, public_key_pem: value.public_key_pem, active: value.active, not_before: value.not_before, expires_at: value.expires_at });
}

function acceptedEd25519Key(pem: string): ReturnType<typeof createPublicKey> {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString() !== pem) throw new Error("invalid public key");
  return key;
}

export function parseProgressSignal(value: unknown): ProgressSignal {
  try {
    const record: Record<string, unknown> = isRecord(value) ? value : invalidSignal();
    if (!exactKeys(record, SIGNAL_KEYS)) invalidSignal();
    if (record.schema_version !== 1 || record.source !== "provider_bridge" || !isProvider(record.provider) || !isIdentifier(record.terminal_id, 256) || !isIdentifier(record.incarnation_id, 256) || !isNullableIdentifier(record.cursor) || !isSequence(record.sequence) || !isSignalState(record.state) || typeof record.reason_code !== "string" || !REASONS[record.provider][record.state].includes(record.reason_code as ProgressReasonCode) || record.active !== true || !isRfc3339Millis(record.observed_at) || !isEventId(record.event_id) || !isIdentifier(record.key_id, 128) || record.algorithm !== "Ed25519" || !isBase64url(record.signature)) invalidSignal();
    const signal = Object.freeze({ schema_version: record.schema_version, source: record.source, provider: record.provider, terminal_id: record.terminal_id, incarnation_id: record.incarnation_id, cursor: record.cursor, sequence: record.sequence, state: record.state, reason_code: record.reason_code as ProgressReasonCode, active: record.active, observed_at: record.observed_at, event_id: record.event_id, key_id: record.key_id, algorithm: record.algorithm, signature: record.signature }) as ProgressSignal;
    if (signal.event_id !== eventId(signal)) invalidSignal();
    return signal;
  } catch (error) {
    if (error instanceof JarvisError && error.code === "PROGRESS_SIGNAL_INVALID") throw error;
    return invalidSignal();
  }
}

export function progressSignalPayload(signal: ProgressSignal): Omit<ProgressSignal, "signature"> {
  const parsed = parseProgressSignal(signal);
  return { schema_version: parsed.schema_version, source: parsed.source, provider: parsed.provider, terminal_id: parsed.terminal_id, incarnation_id: parsed.incarnation_id, cursor: parsed.cursor, sequence: parsed.sequence, state: parsed.state, reason_code: parsed.reason_code, active: parsed.active, observed_at: parsed.observed_at, event_id: parsed.event_id, key_id: parsed.key_id, algorithm: parsed.algorithm };
}

export function verifyProgressSignal(signal: ProgressSignal, key: ProgressSignalKey, now: Date): boolean {
  try {
    if (!isDate(now)) return false;
    const parsed = parseProgressSignal(signal);
    const parsedKey = parseKey(key);
    if (parsed.key_id !== parsedKey.key_id || parsed.provider !== parsedKey.provider || !parsedKey.active) return false;
    const at = now.getTime();
    if (at < Date.parse(parsedKey.not_before) || at > Date.parse(parsedKey.expires_at)) return false;
    const signature = Buffer.from(parsed.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== parsed.signature) return false;
    return verify(null, Buffer.concat([DOMAIN, Buffer.from(canonicalize(progressSignalPayload(parsed)), "utf8")]), acceptedEd25519Key(parsedKey.public_key_pem), signature);
  } catch {
    return false;
  }
}

function parseInput(input: ProgressEvidenceInput): ProgressEvidenceInput {
  if (!isRecord(input) || !exactKeys(input, INPUT_KEYS) || !isProvider(input.provider) || !isIdentifier(input.terminal_id, 256) || !isIdentifier(input.incarnation_id, 256) || !isNullableIdentifier(input.cursor) || typeof input.connected !== "boolean" || typeof input.capture_complete !== "boolean" || !isRfc3339Millis(input.observed_at) || !isDate(input.now) || !Array.isArray(input.signals) || input.signals.length > 100 || !Array.isArray(input.trusted_keys) || input.trusted_keys.length > 100) invalidInput();
  if (Date.parse(input.observed_at) > input.now.getTime()) invalidInput();
  const ids = new Set<string>();
  for (const key of input.trusted_keys) {
    if (isRecord(key) && typeof key.key_id === "string") {
      if (ids.has(key.key_id)) invalidInput();
      ids.add(key.key_id);
    }
  }
  return input;
}

function result(input: ProgressEvidenceInput, state: ProgressClassification["state"], reason_code: ProgressReasonCode, signal?: ProgressSignal): ProgressClassification {
  return { provider: input.provider, terminal_id: input.terminal_id, incarnation_id: input.incarnation_id, cursor: input.cursor, state, reason_code, observed_at: input.observed_at, signal_event_id: signal?.event_id ?? null, sequence: signal?.sequence ?? null };
}

export function classifyProgressEvidence(input: ProgressEvidenceInput): ProgressClassification {
  const parsedInput = parseInput(input);
  const inputAge = parsedInput.now.getTime() - Date.parse(parsedInput.observed_at);
  if (!parsedInput.capture_complete) return result(parsedInput, "unknown", "incomplete_capture");
  if (inputAge > FRESHNESS_MS) return result(parsedInput, "unknown", "stale_evidence");
  // A fresh, complete disconnected observation is a terminal transport fact.
  // Pre-GJC promotion separately requires a connected, signed final signal.
  if (!parsedInput.connected) return result(parsedInput, "stopped", "terminal_disconnected");
  if (parsedInput.signals.length === 0) return result(parsedInput, "unknown", "no_trusted_signal");

  let keys: ProgressSignalKey[];
  let signals: ProgressSignal[];
  try {
    keys = parsedInput.trusted_keys.map(parseKey);
    signals = parsedInput.signals.map(parseProgressSignal);
    const byId = new Map(keys.map(key => [key.key_id, key]));
    for (const signal of signals) {
      const key = byId.get(signal.key_id);
      if (!key || signal.provider !== parsedInput.provider || signal.terminal_id !== parsedInput.terminal_id || signal.incarnation_id !== parsedInput.incarnation_id || signal.cursor !== parsedInput.cursor || !verifyProgressSignal(signal, key, parsedInput.now)) throw new Error("invalid signal");
    }
  } catch {
    return result(parsedInput, "unknown", "invalid_signal");
  }

  if (signals.some(signal => signal.observed_at > parsedInput.now.toISOString() || parsedInput.now.getTime() - Date.parse(signal.observed_at) > FRESHNESS_MS)) return result(parsedInput, "unknown", "stale_evidence");
  let maximum = signals[0]!;
  for (const signal of signals.slice(1)) if (BigInt(signal.sequence) > BigInt(maximum.sequence)) maximum = signal;
  const top = signals.filter(signal => signal.sequence === maximum.sequence);
  const replay = `${canonicalize(progressSignalPayload(top[0]!))}\0${top[0]!.signature}`;
  if (top.some(signal => `${canonicalize(progressSignalPayload(signal))}\0${signal.signature}` !== replay)) return result(parsedInput, "unknown", "ambiguous_evidence");
  return result(parsedInput, maximum.state, maximum.reason_code, maximum);
}
