import { PERSONAL_OS_SCENARIO_CLASSES, type PersonalOsCorpus, type PersonalOsExpected, type PersonalOsRecord,
  type PersonalOsScenario } from "./personal-os-eval-types.js";
import { computePersonalOsRecordDigest } from "./personal-os-record-digest.js";

export const PERSONAL_OS_CORPUS_INVALID = "PERSONAL_OS_CORPUS_INVALID" as const;
export class PersonalOsCorpusError extends Error {
  readonly name = "PersonalOsCorpusError";
  constructor(readonly code: typeof PERSONAL_OS_CORPUS_INVALID) { super(code); }
}
const CORPUS_KEYS = ["schema_version", "corpus_id", "fixed_clock", "scenarios"] as const;
const SCENARIO_KEYS = ["id", "class", "query_subject", "query_at", "records", "expected"] as const;
const RECORD_KEYS = ["id", "subject", "value", "kind", "state", "trust", "authority", "observed_at", "valid_from",
  "valid_until", "fresh_until", "digest", "transfer_digest", "evidence_link", "session_id", "relationship"] as const;
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
  const actual = Object.keys(input); if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
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
    || Buffer.byteLength(value, "utf8") > maximum || [...value].some(character => character.charCodeAt(0) < 32
      || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function instant(value: unknown): string {
  const parsed = text(value, 32); const milliseconds = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed) || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== parsed) return fail();
  return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail(); return values.find(candidate => candidate === value) ?? fail();
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value, 2_048); }
function strings(value: unknown, maximum = 64): readonly string[] {
  const parsed = list(value, maximum).map(item => text(item)); if (new Set(parsed).size !== parsed.length) return fail(); return parsed;
}
function parseRecord(value: unknown): PersonalOsRecord {
  const input = record(value); closed(input, RECORD_KEYS);
  const parsed: PersonalOsRecord = {
    id: text(input["id"]), subject: text(input["subject"]), value: text(input["value"], 2_048),
    kind: choice(input["kind"], ["fact", "principle", "gap"] as const),
    state: choice(input["state"], ["active", "stale", "deleted", "no_data"] as const),
    trust: choice(input["trust"], ["confirmed", "inferred", "untrusted"] as const),
    authority: choice(input["authority"], ["none", "owner"] as const), observed_at: instant(input["observed_at"]),
    valid_from: instant(input["valid_from"]), valid_until: instant(input["valid_until"]), fresh_until: instant(input["fresh_until"]),
    digest: text(input["digest"], 71), transfer_digest: text(input["transfer_digest"], 71),
    evidence_link: text(input["evidence_link"]), session_id: text(input["session_id"]),
    relationship: choice(input["relationship"], ["direct", "supporting", "unrelated"] as const),
  };
  if (Date.parse(parsed.valid_from) >= Date.parse(parsed.valid_until) || Date.parse(parsed.observed_at) > Date.parse(parsed.fresh_until)
    || (parsed.state === "deleted" && Date.parse(parsed.observed_at) <= Date.parse(parsed.valid_from))
    || Date.parse(parsed.fresh_until) > Date.parse(parsed.valid_until) || !/^sha256:[0-9a-f]{64}$/.test(parsed.digest)
    || !/^sha256:[0-9a-f]{64}$/.test(parsed.transfer_digest)
    || !/^evidence:synthetic:[a-z0-9][a-z0-9:-]{0,120}$/.test(parsed.evidence_link)
    || computePersonalOsRecordDigest(parsed) !== parsed.digest) return fail();
  return parsed;
}
function parseExpected(value: unknown): PersonalOsExpected {
  const input = record(value); closed(input, EXPECTED_KEYS);
  return { outcome: choice(input["outcome"], ["answer", "abstain", "reject", "decision"] as const),
    record_ids: strings(input["record_ids"]), citation_links: strings(input["citation_links"]),
    value: nullableText(input["value"]), reason_code: text(input["reason_code"]) };
}
function parseScenario(value: unknown, fixedClock: string): PersonalOsScenario {
  const input = record(value); closed(input, SCENARIO_KEYS); const queryAt = instant(input["query_at"]);
  if (Date.parse(queryAt) > Date.parse(fixedClock)) return fail();
  const records = list(input["records"], 64).map(parseRecord);
  if (records.some(item => Date.parse(item.observed_at) > Date.parse(fixedClock))) return fail();
  const expected = parseExpected(input["expected"]);
  if (expected.record_ids.some(id => !records.some(item => item.id === id))
    || expected.citation_links.some(link => !records.some(item => item.evidence_link === link))) return fail();
  return { id: text(input["id"]), class: choice(input["class"], PERSONAL_OS_SCENARIO_CLASSES),
    query_subject: text(input["query_subject"]), query_at: queryAt, records, expected };
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
export function parsePersonalOsCorpus(value: unknown): PersonalOsCorpus {
  const input = record(value); closed(input, CORPUS_KEYS); if (input["schema_version"] !== 1) return fail();
  const fixedClock = instant(input["fixed_clock"]); const scenarios = list(input["scenarios"], 64).map(item => parseScenario(item, fixedClock));
  const records = scenarios.flatMap(item => item.records); const subjects = [...new Set(records.map(item => item.subject))];
  const foldedSubjects = subjects.map(item => item.toLocaleLowerCase("en-US"));
  const tombstoneInstants = records.filter(item => item.state === "deleted").map(item => `${item.subject}\u0000${item.observed_at}`);
  if (scenarios.length === 0 || !unique(scenarios.map(item => item.id)) || !unique(records.map(item => item.id))
    || !unique(records.map(item => item.evidence_link)) || !unique(records.map(item => item.digest)) || !unique(foldedSubjects)
    || !unique(tombstoneInstants)) return fail();
  return { schema_version: 1, corpus_id: text(input["corpus_id"]), fixed_clock: fixedClock, scenarios };
}
