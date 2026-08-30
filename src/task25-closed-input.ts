import { types as utilTypes } from "node:util";
import { JarvisError } from "./db.js";

export type ClosedJson = null | boolean | number | string
  | readonly ClosedJson[] | { readonly [key: string]: ClosedJson };
const SURROGATE = /[\uD800-\uDFFF]/u;
const PRIVATE_KEY = /(?:password|passwd|token|secret|credential|cookie|authorization|private[_-]?key)/iu;
export function task25Invalid(): never { throw new JarvisError("RECOMMENDATION_WORKFLOW_INVALID"); }
const fail = task25Invalid;
function descriptors(value: object): Readonly<Record<PropertyKey, PropertyDescriptor>> {
  if (utilTypes.isProxy(value)) return fail();
  try { return Object.getOwnPropertyDescriptors(value); }
  catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
export function closedRecord(
  value: unknown,
  expected?: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || Array.isArray(value)) return fail();
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const own = Reflect.ownKeys(value); const all = descriptors(value);
    if (own.some(key => typeof key !== "string")
      || (expected !== undefined && (own.length !== expected.length
        || own.some(key => !expected.includes(String(key)))))) return fail();
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of own) {
      const descriptor = all[key];
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable
        || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) return fail();
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
export function closedArray(value: unknown, maximum: number): readonly unknown[] {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || !Array.isArray(value)) return fail();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return fail();
    const own = Reflect.ownKeys(value); const all = descriptors(value); const length = all["length"];
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)
      || Number(length.value) < 0 || Number(length.value) > maximum || length.enumerable
      || length.configurable || !length.writable) return fail();
    const size = Number(length.value); const expected = Array.from({ length: size }, (_, index) => String(index));
    if (own.length !== size + 1 || own[size] !== "length"
      || expected.some((key, index) => own[index] !== key)) return fail();
    const result: unknown[] = [];
    for (const key of expected) {
      const descriptor = all[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
        || !descriptor.configurable || !descriptor.writable
        || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
      result.push(descriptor.value);
    }
    return result;
  } catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
export function closedText(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || SURROGATE.test(value) || Buffer.byteLength(value, "utf8") > maximum) return fail();
  return value;
}
export function closedInteger(value: unknown, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value) : fail();
}
export function closedJsonRecord(
  value: unknown,
  depth = 0,
): { readonly [key: string]: ClosedJson } {
  const input = closedRecord(value);
  if (depth > 4 || Object.keys(input).length > 16) return fail();
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (PRIVATE_KEY.test(key)) throw new JarvisError("RECOMMENDATION_WORKFLOW_PRIVATE_INPUT");
    return [closedText(key, 64), closedJson(item, depth + 1)];
  }));
}
export function closedJson(value: unknown, depth = 0): ClosedJson {
  if (depth > 4) return fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? closedText(value, 1024) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : fail();
  if (typeof value !== "object" || utilTypes.isProxy(value)) return fail();
  if (Array.isArray(value)) return closedArray(value, 16).map(item => closedJson(item, depth + 1));
  return closedJsonRecord(value, depth);
}
export function task25Timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return fail();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return fail();
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? value : fail();
}
export function task25Date(value: unknown): Date {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || !utilTypes.isDate(value)) return fail();
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) return fail();
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : fail();
  } catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
