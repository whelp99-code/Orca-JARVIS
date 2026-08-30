import { DashboardApiError } from "./api.js";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT = 4096;

export function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return fail();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
        || !descriptor.enumerable) return fail();
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) throw error;
    if (error instanceof TypeError) return fail();
    throw error;
  }
}

export function closedArray<T>(value: unknown, parse: (item: unknown) => T, maximum: number): readonly T[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
    const parsed: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
        || !descriptor.enumerable) return fail();
      parsed.push(parse(descriptor.value));
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) throw error;
    if (error instanceof TypeError) return fail();
    throw error;
  }
}

export function closedDiscriminant(value: unknown, key: string): string {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
      || !descriptor.enumerable || typeof descriptor.value !== "string") return fail();
    return descriptor.value;
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) throw error;
    if (error instanceof TypeError) return fail();
    throw error;
  }
}

export function hasClosedDataField(value: unknown, key: string): boolean {
  try {
    if (typeof value !== "object" || value === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined && descriptor.enumerable === true;
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find((candidate) => candidate === value) ?? fail();
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}
export function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!TIME.test(parsed) || !Number.isFinite(Date.parse(parsed))) return fail();
  return parsed;
}
export function digest(value: unknown): string {
  const parsed = text(value);
  return /^sha256:[0-9a-f]{64}$/u.test(parsed) ? parsed : fail();
}
export function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}
export function integer(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail();
}
export function literal<T extends string | number>(value: unknown, expected: T): T {
  return value === expected ? expected : fail();
}
export function validationFailure(): never { return fail(); }
function fail(): never {
  throw new DashboardApiError({ kind: "server", code: "VALIDATION_ERROR", message: "Validation error", request_id: "" });
}
