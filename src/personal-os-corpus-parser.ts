import {
  PERSONAL_OS_SCENARIO_CLASSES,
  type PersonalOsCorpus,
  type PersonalOsExpected,
  type PersonalOsRecord,
  type PersonalOsScenario,
} from "./personal-os-eval-types.js";

export const PERSONAL_OS_CORPUS_INVALID = "PERSONAL_OS_CORPUS_INVALID" as const;
export class PersonalOsCorpusError extends Error {
  readonly name = "PersonalOsCorpusError";
  constructor(readonly code: typeof PERSONAL_OS_CORPUS_INVALID) { super(code); }
}
const CORPUS_KEYS = ["schema_version", "corpus_id", "fixed_clock", "scenarios"] as const;
const SCENARIO_KEYS = ["id", "class", "query_subject", "query_at", "records", "expected"] as const;
const RECORD_KEYS = [
  "id", "subject", "value", "kind", "state", "trust", "observed_at", "valid_from", "valid_until",
  "fresh_until", "digest", "transfer_digest", "evidence_link", "session_id", "related", "injection",
] as const;
const EXPECTED_KEYS = ["outcome", "record_ids", "citation_links", "value", "reason_code"] as const;
const fail = (): never => { throw new PersonalOsCorpusError(PERSONAL_OS_CORPUS_INVALID); };
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
  }
  return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key]?.value]));
}
function closed(input: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    output.push(descriptor.value);
  }
  return output;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function instant(value: unknown): string {
  const parsed = text(value, 32);
  const milliseconds = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return fail();
  return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find(candidate => candidate === value) ?? fail();
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return fail(); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value, 2_048); }
function strings(value: unknown, maximum = 64): readonly string[] {
  const parsed = list(value, maximum).map(item => text(item));
  if (new Set(parsed).size !== parsed.length) return fail();
  return parsed;
}
function parseRecord(value: unknown): PersonalOsRecord {
  const input = record(value); closed(input, RECORD_KEYS);
  const observedAt = instant(input["observed_at"]); const validFrom = instant(input["valid_from"]);
  const validUntil = instant(input["valid_until"]); const freshUntil = instant(input["fresh_until"]);
  const digest = text(input["digest"], 71); const transferDigest = text(input["transfer_digest"], 71);
  if (Date.parse(validFrom) >= Date.parse(validUntil) || Date.parse(observedAt) > Date.parse(freshUntil)
    || !/^sha256:[0-9a-f]{64}$/.test(digest) || !/^sha256:[0-9a-f]{64}$/.test(transferDigest)) return fail();
  const evidenceLink = text(input["evidence_link"]);
  if (!/^evidence:synthetic:[a-z0-9][a-z0-9:-]{0,120}$/.test(evidenceLink)) return fail();
  return {
    id: text(input["id"]), subject: text(input["subject"]), value: text(input["value"], 2_048),
    kind: choice(input["kind"], ["fact", "principle", "gap"] as const),
    state: choice(input["state"], ["active", "stale", "deleted", "no_data"] as const),
    trust: choice(input["trust"], ["confirmed", "inferred"] as const), observed_at: observedAt,
    valid_from: validFrom, valid_until: validUntil, fresh_until: freshUntil, digest, transfer_digest: transferDigest,
    evidence_link: evidenceLink, session_id: text(input["session_id"]), related: boolean(input["related"]),
    injection: boolean(input["injection"]),
  };
}
function parseExpected(value: unknown): PersonalOsExpected {
  const input = record(value); closed(input, EXPECTED_KEYS);
  return { outcome: choice(input["outcome"], ["answer", "abstain", "reject", "decision"] as const),
    record_ids: strings(input["record_ids"]), citation_links: strings(input["citation_links"]),
    value: nullableText(input["value"]), reason_code: text(input["reason_code"]) };
}
function parseScenario(value: unknown): PersonalOsScenario {
  const input = record(value); closed(input, SCENARIO_KEYS);
  const records = list(input["records"], 64).map(parseRecord);
  if (new Set(records.map(item => item.id)).size !== records.length) return fail();
  const expected = parseExpected(input["expected"]);
  if (expected.record_ids.some(id => !records.some(item => item.id === id))) return fail();
  return { id: text(input["id"]), class: choice(input["class"], PERSONAL_OS_SCENARIO_CLASSES),
    query_subject: text(input["query_subject"]), query_at: instant(input["query_at"]), records, expected };
}
export function parsePersonalOsCorpus(value: unknown): PersonalOsCorpus {
  const input = record(value); closed(input, CORPUS_KEYS);
  if (input["schema_version"] !== 1) return fail();
  const scenarios = list(input["scenarios"], 64).map(parseScenario);
  if (scenarios.length === 0 || new Set(scenarios.map(item => item.id)).size !== scenarios.length) return fail();
  return { schema_version: 1, corpus_id: text(input["corpus_id"]), fixed_clock: instant(input["fixed_clock"]), scenarios };
}
