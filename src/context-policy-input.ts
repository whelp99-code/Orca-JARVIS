import { parsePersonalOsPolicy, PersonalPolicyError } from "./personal-os-policy.js";
export const CONTEXT_POLICY_INPUT_INVALID = "CONTEXT_POLICY_INPUT_INVALID" as const;
export const CONTEXT_POLICY_CONFIG_INVALID = "CONTEXT_POLICY_CONFIG_INVALID" as const;
export type ContextPolicyErrorCode = typeof CONTEXT_POLICY_INPUT_INVALID | typeof CONTEXT_POLICY_CONFIG_INVALID;

export class ContextPolicyError extends Error {
  readonly name = "ContextPolicyError";
  constructor(readonly code: ContextPolicyErrorCode) { super(code); }
}

const CLASSES = ["linux_live_fact", "user_confirmed_principle", "owner_decision"] as const;
const HOSTS = ["linux-control-plane", "linux-second-brain", "mac-client", "phone-client"] as const;
const STATES = ["current", "stale"] as const;
const GAP_STATES = ["no_data", "offline", "unavailable"] as const;
const TRUST = ["user_confirmed", "inferred", "untrusted"] as const;
const RELATIONS = ["supports", "contradicts", "supersedes", "unrelated"] as const;
const INPUT_KEYS = ["schema_version", "clock", "required_evidence", "evidence"] as const;
const FACT_KEYS = [
  "kind", "ref", "evidence_class", "source_host", "state", "trust", "relation", "relates_to",
  "observed_at", "valid_from", "valid_until", "fresh_until",
] as const;
const GAP_KEYS = ["kind", "ref", "evidence_class", "source_host", "state", "checked_at"] as const;

export type EvidenceClass = (typeof CLASSES)[number];
export type ContextFact = {
  readonly kind: "evidence";
  readonly ref: string;
  readonly evidence_class: EvidenceClass;
  readonly source_host: (typeof HOSTS)[number];
  readonly state: (typeof STATES)[number];
  readonly trust: (typeof TRUST)[number];
  readonly relation: (typeof RELATIONS)[number];
  readonly relates_to: string | null;
  readonly observed_at: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly fresh_until: string;
};
export type ContextGap = {
  readonly kind: "gap";
  readonly ref: string;
  readonly evidence_class: EvidenceClass;
  readonly source_host: (typeof HOSTS)[number];
  readonly state: (typeof GAP_STATES)[number];
  readonly checked_at: string;
};
export type ParsedContextPolicyInput = {
  readonly clock: string;
  readonly required_evidence: readonly EvidenceClass[];
  readonly evidence: readonly (ContextFact | ContextGap)[];
};
export type ParsedContextPolicy = ReturnType<typeof parsePersonalOsPolicy>;

type Boundary = "config" | "input";
const fail = (boundary: Boundary): never => {
  throw new ContextPolicyError(boundary === "config" ? CONTEXT_POLICY_CONFIG_INVALID : CONTEXT_POLICY_INPUT_INVALID);
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, boundary: Boundary): Record<string, unknown> {
  if (!isRecord(value)) return fail(boundary);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(boundary);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail(boundary);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return fail(boundary);
  }
  return value;
}
function list(value: unknown, boundary: Boundary, maximum = 64): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail(boundary);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return fail(boundary);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return fail(boundary);
  }
  return value;
}
function safeClone(value: unknown, depth = 0): unknown {
  if (depth > 12) return fail("config");
  if (Array.isArray(value)) return list(value, "config").map(item => safeClone(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const source = record(value, "config");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) return fail("config");
    output[key] = safeClone(descriptor.value, depth + 1);
  }
  return output;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail("input");
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail("input");
  return value;
}
function instant(value: unknown): string {
  const parsed = text(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed)) || new Date(Date.parse(parsed)).toISOString() !== parsed) return fail("input");
  return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, choices: Values): Values[number] {
  if (typeof value !== "string") return fail("input");
  return choices.find(candidate => candidate === value) ?? fail("input");
}
const nullableRef = (value: unknown): string | null => value === null ? null : text(value);

function parseFact(input: Record<string, unknown>): ContextFact {
  closed(input, FACT_KEYS);
  const observedAt = instant(input["observed_at"]);
  const validFrom = instant(input["valid_from"]);
  const validUntil = instant(input["valid_until"]);
  const freshUntil = instant(input["fresh_until"]);
  if (Date.parse(validFrom) >= Date.parse(validUntil)
    || Date.parse(freshUntil) <= Date.parse(observedAt)) return fail("input");
  const relation = choice(input["relation"], RELATIONS);
  const relatesTo = nullableRef(input["relates_to"]);
  if ((relation === "contradicts" || relation === "supersedes") && relatesTo === null) return fail("input");
  return {
    kind: "evidence", ref: text(input["ref"]), evidence_class: choice(input["evidence_class"], CLASSES),
    source_host: choice(input["source_host"], HOSTS), state: choice(input["state"], STATES),
    trust: choice(input["trust"], TRUST), relation, relates_to: relatesTo, observed_at: observedAt,
    valid_from: validFrom, valid_until: validUntil, fresh_until: freshUntil,
  };
}
function parseEvidence(value: unknown): ContextFact | ContextGap {
  const input = record(value, "input");
  const kind = choice(input["kind"], ["evidence", "gap"] as const);
  switch (kind) {
    case "evidence": return parseFact(input);
    case "gap": closed(input, GAP_KEYS); return {
      kind, ref: text(input["ref"]), evidence_class: choice(input["evidence_class"], CLASSES),
      source_host: choice(input["source_host"], HOSTS), state: choice(input["state"], GAP_STATES),
      checked_at: instant(input["checked_at"]),
    };
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

export function parseContextPolicyConfig(value: unknown): ParsedContextPolicy {
  try {
    const policy = parsePersonalOsPolicy(safeClone(value));
    if (policy.policy_id !== "personal-os-policy-v1") return fail("config");
    return policy;
  } catch (error) {
    if (error instanceof PersonalPolicyError) return fail("config");
    throw error;
  }
}
export function parseContextPolicyInput(value: unknown): ParsedContextPolicyInput {
  const input = record(value, "input"); closed(input, INPUT_KEYS);
  if (input["schema_version"] !== 1) return fail("input");
  const required = list(input["required_evidence"], "input", CLASSES.length).map(item => choice(item, CLASSES));
  const evidence = list(input["evidence"], "input").map(parseEvidence);
  if (required.length === 0 || new Set(required).size !== required.length
    || new Set(evidence.map(item => item.ref)).size !== evidence.length) return fail("input");
  return { clock: instant(input["clock"]), required_evidence: required, evidence };
}
