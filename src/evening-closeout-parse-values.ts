import { types } from "node:util";
import { EveningCloseoutError } from "./evening-closeout-types.js";
import { containsPrivateMetadata } from "./private-text.js";

export const invalidCloseout = (): never => {
  throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
};
export type ClosedInput = Readonly<Record<string, unknown>>;
export function closedObject(value: unknown, keys: readonly string[]): ClosedInput {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return invalidCloseout();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return invalidCloseout();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined
        || descriptor.set !== undefined) return invalidCloseout();
    }
    return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
  } catch (error) {
    if (error instanceof EveningCloseoutError) throw error;
    return invalidCloseout();
  }
}
export function closedArray(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) return invalidCloseout();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) return invalidCloseout();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined
        || descriptor.set !== undefined) return invalidCloseout();
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof EveningCloseoutError) throw error;
    return invalidCloseout();
  }
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
export function closeoutText(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || hasUnpairedSurrogate(value) || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum || containsPrivateMetadata(value)
    || [...value].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) return invalidCloseout();
  return value;
}
export function closeoutInstant(value: unknown): string {
  const parsed = closeoutText(value, 32);
  const time = Date.parse(parsed);
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    && Number.isFinite(time) && new Date(time).toISOString() === parsed ? parsed : invalidCloseout();
}
export function closeoutDigest(value: unknown): string {
  const parsed = closeoutText(value, 71);
  return /^sha256:[0-9a-f]{64}$/.test(parsed) ? parsed : invalidCloseout();
}
export function closeoutMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  return typeof value === "string"
    ? values.find(candidate => candidate === value) ?? invalidCloseout()
    : invalidCloseout();
}
export function closeoutInteger(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : invalidCloseout();
}
export function closeoutBoolean(value: unknown): boolean {
  return value === true ? true : value === false ? false : invalidCloseout();
}
