import { CONTEXT_POLICY_REASON_CODES } from "./context-policy.js";
import { types } from "node:util";
import { classifyPriorityDeadline } from "./priority-engine-ranking.js";
import {
  PRIORITY_LEXICOGRAPHIC_ORDER,
  PRIORITY_LEXICOGRAPHIC_POLICY,
  PRIORITY_REASON_CODES,
  type PriorityActionDecision,
  type PriorityCitations,
  type PriorityEngineResult,
  type PriorityDeadline,
  type PriorityLexicographicFields,
  type PriorityRationale,
} from "./priority-engine-contracts.js";

export class PriorityResultContractError extends Error {
  readonly name = "PriorityResultContractError";
  constructor() { super("PRIORITY_RESULT_INVALID"); }
}

const fail = (): never => { throw new PriorityResultContractError(); };
type Input = Readonly<Record<string, unknown>>;
function object(value: unknown, keys: readonly string[]): Input {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
function array(value: unknown, maximum = 64): readonly unknown[] {
  if (typeof value !== "object" || value === null || types.isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1 || !own.includes("length")) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    result.push(descriptor.value);
  }
  return result;
}
function string(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function instant(value: unknown): string {
  const parsed = string(value, 32);
  const milliseconds = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return fail();
  return parsed;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find(candidate => candidate === value) ?? fail();
}
function nullableMember<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | null {
  return value === null ? null : member(value, values);
}
function strings<const Values extends readonly string[]>(value: unknown, values: Values): readonly Values[number][] {
  return array(value).map(item => member(item, values));
}
function orderedStrings<const Values extends readonly string[]>(value: unknown, values: Values): readonly Values[number][] {
  const parsed = strings(value, values);
  if (new Set(parsed).size !== parsed.length
    || parsed.some((item, index) => index > 0
      && values.indexOf(item) <= values.indexOf(parsed[index - 1] ?? item))) return fail();
  return parsed;
}
function nullableRank(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 32) return fail();
  return value;
}
function citations(value: unknown): PriorityCitations {
  const keys = ["confirmed_principle_ref", "confirmed_principle_evidence_ref", "linux_policy_decision_ref",
    "owner_import_decision_ref", "current_linux_evidence_ref", "deadline_evidence_ref", "dependency_evidence_ref",
    "owner_gate_ref", "stable_identity_evidence_ref"] as const;
  const input = object(value, keys);
  return {
    confirmed_principle_ref: nullableString(input["confirmed_principle_ref"]),
    confirmed_principle_evidence_ref: nullableString(input["confirmed_principle_evidence_ref"]),
    linux_policy_decision_ref: nullableString(input["linux_policy_decision_ref"]),
    owner_import_decision_ref: nullableString(input["owner_import_decision_ref"]),
    current_linux_evidence_ref: nullableString(input["current_linux_evidence_ref"]),
    deadline_evidence_ref: nullableString(input["deadline_evidence_ref"]),
    dependency_evidence_ref: nullableString(input["dependency_evidence_ref"]),
    owner_gate_ref: nullableString(input["owner_gate_ref"]),
    stable_identity_evidence_ref: nullableString(input["stable_identity_evidence_ref"]),
  };
}
function fields(value: unknown): PriorityLexicographicFields {
  const input = object(value, PRIORITY_LEXICOGRAPHIC_ORDER);
  return {
    owner_safety_gate: member(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    customer_impact: member(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline_bucket: member(input["deadline_bucket"], PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    dependency_blocking: member(input["dependency_blocking"], PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    irreversible_risk: member(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: member(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    stable_identity: nullableString(input["stable_identity"]),
  };
}
function rationale(value: unknown): PriorityRationale {
  const input = object(value, ["decisive_field", "lexicographic_fields", "citations"]);
  return {
    decisive_field: nullableMember(input["decisive_field"], [...PRIORITY_LEXICOGRAPHIC_ORDER, "only_action"] as const),
    lexicographic_fields: fields(input["lexicographic_fields"]),
    citations: citations(input["citations"]),
  };
}
function action(value: unknown): PriorityActionDecision {
  const input = object(value, ["action_id", "rank", "disposition", "authority", "reason_codes", "rationale"]);
  return {
    action_id: string(input["action_id"]),
    rank: nullableRank(input["rank"]),
    disposition: member(input["disposition"], ["executable", "delegated", "owner_gate_required", "excluded", "abstained"] as const),
    authority: member(input["authority"], ["none"] as const),
    reason_codes: orderedStrings(input["reason_codes"], PRIORITY_REASON_CODES),
    rationale: rationale(input["rationale"]),
  };
}

export function parsePriorityEngineResult(value: unknown): PriorityEngineResult {
  const keys = ["schema_version", "generated_at", "status", "authority", "effect", "policy_id",
    "linux_policy_decision_ref", "context_policy_reason_codes", "lexicographic_order", "reason_codes", "actions"] as const;
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fail();
  const version = Object.getOwnPropertyDescriptor(value, "schema_version")?.value;
  if (version !== 1 && version !== 2) return fail();
  const input = object(value, version === 2 ? [...keys, "deadline_evidence"] : keys);
  const order = strings(input["lexicographic_order"], PRIORITY_LEXICOGRAPHIC_ORDER);
  if (order.length !== PRIORITY_LEXICOGRAPHIC_ORDER.length
    || order.some((field, index) => field !== PRIORITY_LEXICOGRAPHIC_ORDER[index])) return fail();
  const actions = array(input["actions"], 32).map(action);
  const ranked = actions.filter(item => item.rank !== null);
  if (ranked.some((item, index) => item.rank !== index + 1)
    || new Set(actions.map(item => item.action_id)).size !== actions.length) return fail();
  const result: PriorityEngineResult = {
    schema_version: 1,
    generated_at: instant(input["generated_at"]),
    status: member(input["status"], ["ranked", "abstained"] as const),
    authority: member(input["authority"], ["none"] as const),
    effect: member(input["effect"], ["none"] as const),
    policy_id: string(input["policy_id"]),
    linux_policy_decision_ref: nullableString(input["linux_policy_decision_ref"]),
    context_policy_reason_codes: orderedStrings(input["context_policy_reason_codes"], CONTEXT_POLICY_REASON_CODES),
    lexicographic_order: PRIORITY_LEXICOGRAPHIC_ORDER,
    reason_codes: orderedStrings(input["reason_codes"], PRIORITY_REASON_CODES),
    actions,
  };
  if ((result.status === "ranked") !== (ranked.length > 0)) return fail();
  if (version === 1) return result;
  const deadlines = array(input["deadline_evidence"], 32).map(value => {
    const entry = object(value, ["action_id", "deadline"]);
    return { action_id: string(entry["action_id"]), deadline: deadline(entry["deadline"], result.generated_at) };
  });
  if (deadlines.length !== actions.length) return fail();
  for (const [index, entry] of deadlines.entries()) {
    const item = actions[index];
    if (item === undefined || item.action_id !== entry.action_id
      || classifyPriorityDeadline(entry.deadline, result.generated_at) !== item.rationale.lexicographic_fields.deadline_bucket) return fail();
    const ref = item.rationale.citations.deadline_evidence_ref;
    if (ref !== null && ref !== entry.deadline?.evidence_ref) return fail();
    if (item.rank !== null && entry.deadline !== null
      && (ref === null || entry.deadline.fresh_until <= result.generated_at)) return fail();
  }
  return { ...result, schema_version: 2, deadline_evidence: deadlines };
}

function deadline(value: unknown, generatedAt: string): PriorityDeadline | null {
  if (value === null) return null;
  const input = object(value, ["due_at", "evidence_ref", "observed_at", "fresh_until"]);
  const parsed = { due_at: instant(input["due_at"]), evidence_ref: nullableString(input["evidence_ref"]),
    observed_at: instant(input["observed_at"]), fresh_until: instant(input["fresh_until"]) };
  if (parsed.observed_at > generatedAt || parsed.fresh_until <= parsed.observed_at) return fail();
  return parsed;
}
