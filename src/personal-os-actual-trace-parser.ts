import type { PersonalOsActualTrace, PersonalOsCorpus, PersonalOsDependencies, PersonalOsEffectEvent } from "./personal-os-eval-types.js";

export const PERSONAL_OS_ACTUAL_TRACE_INVALID = "PERSONAL_OS_ACTUAL_TRACE_INVALID" as const;
export class PersonalOsActualTraceError extends TypeError {
  readonly name = "PersonalOsActualTraceError";
  constructor(readonly code: typeof PERSONAL_OS_ACTUAL_TRACE_INVALID) { super(code); }
}

const TRACE_KEYS = ["schema_version", "scenario_id", "outcome", "selected_record_ids", "citation_links", "session_ids",
  "value", "reason_code", "temporal_observation", "effect_events", "dependencies"] as const;
const DEPENDENCY_KEYS = ["model_calls", "network_calls", "mac_calls"] as const;
const EFFECTS = ["unauthorized", "approval_bypass", "duplicate", "stale_authoritative", "deletion_leak"] as const;
const fail = (): never => { throw new PersonalOsActualTraceError(PERSONAL_OS_ACTUAL_TRACE_INVALID); };

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value); const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    output[key] = descriptor.value;
  }
  return output;
}
function closed(input: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const parsed: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    parsed.push(descriptor.value);
  }
  return parsed;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum || [...value].some(character => {
      const code = character.codePointAt(0); return code === undefined || code < 32 || code === 127;
    })) return fail();
  return value;
}
function strings(value: unknown): readonly string[] {
  const parsed = list(value, 64).map(item => text(item));
  if (new Set(parsed).size !== parsed.length) return fail();
  return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find(candidate => candidate === value) ?? fail();
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
function parseDependencies(value: unknown): PersonalOsDependencies {
  const input = record(value); closed(input, DEPENDENCY_KEYS);
  return { model_calls: count(input["model_calls"]), network_calls: count(input["network_calls"]), mac_calls: count(input["mac_calls"]) };
}
function parseTrace(value: unknown): PersonalOsActualTrace {
  const input = record(value); closed(input, TRACE_KEYS);
  if (input["schema_version"] !== 1 || typeof input["temporal_observation"] !== "boolean") return fail();
  return { schema_version: 1, scenario_id: text(input["scenario_id"]),
    outcome: choice(input["outcome"], ["answer", "abstain", "reject", "decision"] as const),
    selected_record_ids: strings(input["selected_record_ids"]), citation_links: strings(input["citation_links"]),
    session_ids: strings(input["session_ids"]), value: input["value"] === null ? null : text(input["value"], 2_048),
    reason_code: text(input["reason_code"]), temporal_observation: input["temporal_observation"],
    effect_events: list(input["effect_events"], 64).map(item => choice(item, EFFECTS)) satisfies readonly PersonalOsEffectEvent[],
    dependencies: parseDependencies(input["dependencies"]) };
}

export function parsePersonalOsActualTraces(corpus: PersonalOsCorpus, value: unknown): readonly PersonalOsActualTrace[] {
  const traces = list(value, 64).map(parseTrace); const expectedIds = new Set(corpus.scenarios.map(item => item.id));
  const actualIds = traces.map(item => item.scenario_id);
  if (traces.length !== expectedIds.size || new Set(actualIds).size !== actualIds.length
    || actualIds.some(id => !expectedIds.has(id))) return fail();
  return traces;
}
