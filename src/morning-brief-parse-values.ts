import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalize } from "./canonical.js";
import { containsPrivateMetadata } from "./private-text.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";
import type { MorningBriefCitation, MorningBriefPriority } from "./morning-brief-types.js";

export class MorningBriefContractError extends Error {
  readonly name = "MorningBriefContractError";
  constructor() { super("MORNING_BRIEF_INPUT_INVALID"); }
}

export const fail = (): never => { throw new MorningBriefContractError(); };
type Input = Readonly<Record<string, unknown>>;
export function object(value: unknown, keys: readonly string[]): Input {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fail();
  if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
export function array(value: unknown, maximum: number): readonly unknown[] {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fail();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    return descriptor.value;
  });
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
function text(value: unknown, maximum = 512, allowTrailing = false): string {
  if (typeof value !== "string" || (allowTrailing ? value.trimStart() !== value : value.trim() !== value)
    || value.length === 0 || hasUnpairedSurrogate(value)
    || value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
export function privateText(value: unknown, maximum = 512, allowTrailing = false): string {
  const parsed = text(value, maximum, allowTrailing);
  return containsPrivateMetadata(parsed) ? fail() : parsed;
}
export function instant(value: unknown): string {
  const parsed = text(value, 32);
  const milliseconds = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return fail();
  return parsed;
}
export function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find(candidate => candidate === value) ?? fail();
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail();
  return value;
}
export function digest(value: unknown): string {
  const parsed = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) return fail();
  return parsed;
}
export const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export function citation(value: unknown): MorningBriefCitation {
  const input = object(value, ["link_id", "source_id", "evidence_ref"]);
  return { link_id: privateText(input["link_id"]), source_id: privateText(input["source_id"]),
    evidence_ref: privateText(input["evidence_ref"]) };
}
export function priority(value: unknown): MorningBriefPriority {
  const input = object(value, ["owner_safety_gate", "customer_impact", "deadline_bucket", "dependency_blocking",
    "irreversible_risk", "effort_cost", "stable_identity"]);
  return {
    owner_safety_gate: member(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    customer_impact: member(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline_bucket: member(input["deadline_bucket"], PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    dependency_blocking: member(input["dependency_blocking"], PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    irreversible_risk: member(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: member(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    stable_identity: privateText(input["stable_identity"]),
  };
}
