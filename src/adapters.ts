import { JarvisError } from "./db.js";
import { parseProgressSignal } from "./progress-signal.js";
import type { ProgressSignal } from "./types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("PROGRESS_SIGNAL_INVALID");
  return value as RecordValue;
};

/** Provider bridges intentionally accept one signed object, never terminal text or status prose. */
function structuredSignal(value: unknown, provider: "codex" | "claude"): ProgressSignal {
  const envelope = record(value);
  if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, "progress_signal")) throw new JarvisError("PROGRESS_SIGNAL_INVALID");
  const signal = parseProgressSignal(envelope.progress_signal);
  if (signal.provider !== provider) throw new JarvisError("PROGRESS_SIGNAL_INVALID");
  return signal;
}

export function ingestCodexAppServerEvent(value: unknown): ProgressSignal { return structuredSignal(value, "codex"); }
export function ingestClaudeHookEvent(value: unknown): ProgressSignal { return structuredSignal(value, "claude"); }
