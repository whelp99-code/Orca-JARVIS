import {
  OBJECT_DEPTH_LIMIT,
  OUTPUT_STRING_LIMIT,
  REDACTED,
  SECRET_KEY_PATTERN,
  TERMINAL_SECRET_PATTERN,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundString(value: string): string {
  return value.length > OUTPUT_STRING_LIMIT ? value.slice(0, OUTPUT_STRING_LIMIT) : value;
}

function secretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

type DeepIndexable<T> =
  T extends null | undefined | string | number | boolean ? T
  : T extends readonly (infer Item)[] ? readonly [DeepIndexable<Item>, ...DeepIndexable<Item>[]]
  : T extends object ? { [K in keyof T]: DeepIndexable<T[K]> }
  : T;

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return boundString(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth));
  if (!isRecord(value)) return value;
  if (depth >= OBJECT_DEPTH_LIMIT) return REDACTED;
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    cloned[key] = secretKey(key) ? REDACTED : walk(child, depth + 1);
  }
  return cloned;
}

export function redactDashboardValue<T>(value: T): DeepIndexable<T>;
export function redactDashboardValue(value: unknown): unknown {
  return walk(value, 0);
}

export function redactTerminalLine(line: string): string {
  return TERMINAL_SECRET_PATTERN.test(line) ? REDACTED : line;
}
