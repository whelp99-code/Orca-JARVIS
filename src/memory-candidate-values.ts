import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalize } from "./canonical.js";
import {
  MEMORY_CANDIDATE_ERROR_CODES,
  MemoryCandidateError,
  type MemoryCandidateErrorCode,
} from "./memory-candidate-types.js";

type Boundary = "input" | "policy";
type CloneBudget = { count: number };
const INPUT_INVALID = MEMORY_CANDIDATE_ERROR_CODES[0];
const POLICY_INVALID = MEMORY_CANDIDATE_ERROR_CODES[1];

export function memoryFail(code: MemoryCandidateErrorCode = INPUT_INVALID): never {
  throw new MemoryCandidateError(code);
}

function boundaryCode(boundary: Boundary): MemoryCandidateErrorCode {
  return boundary === "input" ? INPUT_INVALID : POLICY_INVALID;
}

function descriptors(value: object, boundary: Boundary): Readonly<Record<PropertyKey, PropertyDescriptor>> {
  if (types.isProxy(value)) return memoryFail(boundaryCode(boundary));
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof MemoryCandidateError) throw error;
    return memoryFail(boundaryCode(boundary));
  }
}

export function memoryRecord(
  value: unknown,
  expected: readonly string[] | null = null,
  boundary: Boundary = "input",
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    return memoryFail(boundaryCode(boundary));
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return memoryFail(boundaryCode(boundary));
    const own = Reflect.ownKeys(value);
    const all = descriptors(value, boundary);
    if (own.some(key => typeof key !== "string")
      || (expected !== null && (own.length !== expected.length
        || own.some(key => typeof key !== "string" || !expected.includes(key))))) {
      return memoryFail(boundaryCode(boundary));
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of own) {
      const descriptor = all[key];
      if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)
        || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return memoryFail(boundaryCode(boundary));
      }
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch (error) {
    if (error instanceof MemoryCandidateError) throw error;
    return memoryFail(boundaryCode(boundary));
  }
}

export function memoryArray(value: unknown, maximum: number, boundary: Boundary = "input"): readonly unknown[] {
  if (typeof value !== "object" || value === null || !Array.isArray(value) || types.isProxy(value)) {
    return memoryFail(boundaryCode(boundary));
  }
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return memoryFail(boundaryCode(boundary));
    const own = Reflect.ownKeys(value);
    const all = descriptors(value, boundary);
    const length = all["length"];
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)
      || Number(length.value) < 0 || Number(length.value) > maximum || length.enumerable) {
      return memoryFail(boundaryCode(boundary));
    }
    const size = Number(length.value);
    const expected = Array.from({ length: size }, (_, index) => String(index));
    if (own.length !== size + 1 || expected.some(key => !own.includes(key)) || !own.includes("length")) {
      return memoryFail(boundaryCode(boundary));
    }
    return expected.map(key => {
      const descriptor = all[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return memoryFail(boundaryCode(boundary));
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof MemoryCandidateError) throw error;
    return memoryFail(boundaryCode(boundary));
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function memoryText(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value !== value.normalize("NFC") || hasUnpairedSurrogate(value)
    || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) return memoryFail();
  return value;
}

export function memoryInstant(value: unknown): string {
  const parsed = memoryText(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)) return memoryFail();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return memoryFail();
  return parsed;
}

export function memoryDigest(value: unknown): string {
  const parsed = memoryText(value, 71);
  return /^sha256:[0-9a-f]{64}$/.test(parsed) ? parsed : memoryFail();
}

export function memoryMember<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return memoryFail();
  return values.find(candidate => candidate === value) ?? memoryFail();
}

export function memoryDate(value: unknown): Date {
  if (typeof value !== "object" || value === null || types.isProxy(value) || !types.isDate(value)) return memoryFail();
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) return memoryFail();
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : memoryFail();
  } catch (error) {
    if (error instanceof MemoryCandidateError) throw error;
    return memoryFail();
  }
}

export function memoryHash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}

function clonePolicyValue(value: unknown, depth: number, budget: CloneBudget): unknown {
  budget.count += 1;
  if (budget.count > 512 || depth > 12) return memoryFail(POLICY_INVALID);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    try {
      return memoryText(value, 4_096);
    } catch (error) {
      if (error instanceof MemoryCandidateError) return memoryFail(POLICY_INVALID);
      throw error;
    }
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isSafeInteger(value) ? value : memoryFail(POLICY_INVALID);
  }
  if (typeof value !== "object" || types.isProxy(value)) return memoryFail(POLICY_INVALID);
  if (Array.isArray(value)) {
    return memoryArray(value, 128, "policy").map(item => clonePolicyValue(item, depth + 1, budget));
  }
  const input = memoryRecord(value, null, "policy");
  if (Object.keys(input).length > 64) return memoryFail(POLICY_INVALID);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [
    key,
    clonePolicyValue(item, depth + 1, budget),
  ]));
}

export function cloneMemoryPolicy(value: unknown): unknown {
  const cloned = clonePolicyValue(value, 0, { count: 0 });
  if (Buffer.byteLength(canonicalize(cloned), "utf8") > 65_536) return memoryFail(POLICY_INVALID);
  return cloned;
}
