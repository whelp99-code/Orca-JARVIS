export class PersonalPolicyError extends Error {
  readonly name = "PersonalPolicyError";
  constructor(readonly code: "PERSONAL_POLICY_INVALID") {
    super(code);
  }
}

export function invalid(): never {
  throw new PersonalPolicyError("PERSONAL_POLICY_INVALID");
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value;
}
export function closed(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) invalid();
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return invalid();
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) return invalid();
  return value;
}
export function literal<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] {
  if (typeof value !== "string") return invalid();
  const found = allowed.find((candidate) => candidate === value);
  return found ?? invalid();
}
export function exactList<const Values extends readonly string[]>(value: unknown, allowed: Values): readonly Values[number][] {
  if (!Array.isArray(value) || value.length !== allowed.length) return invalid();
  const parsed = value.map((item) => literal(item, allowed));
  if (new Set(parsed).size !== allowed.length) return invalid();
  return parsed;
}
export function stringList(value: unknown, maximum = 16): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return invalid();
  const parsed = value.map(text);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}
export function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed) || new Date(parsed).toISOString() !== parsed) return invalid();
  return parsed;
}
export function clockTime(value: unknown): string {
  const parsed = text(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed)) return invalid();
  return parsed;
}
export function minutes(value: string): number {
  const [hours = "", minute = ""] = value.split(":");
  return Number(hours) * 60 + Number(minute);
}
export function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
export function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
export function nullableLiteral<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] | null {
  return value === null ? null : literal(value, allowed);
}
