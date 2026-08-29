import { ContextPolicyError } from "./context-policy.js";
import { parseContextPolicyInput } from "./context-policy-input.js";
import {
  PRIORITY_LEXICOGRAPHIC_POLICY,
  type ParsedPriorityEngineInput,
  type PriorityCandidateAction,
  type PriorityDeadline,
  type PriorityDependency,
  type PriorityPrincipleSource,
  type PriorityStableIdentity,
} from "./priority-engine-contracts.js";

export const PRIORITY_ENGINE_INPUT_INVALID = "PRIORITY_ENGINE_INPUT_INVALID" as const;
export const PRIORITY_ENGINE_POLICY_INVALID = "PRIORITY_ENGINE_POLICY_INVALID" as const;
export type PriorityEngineErrorCode = typeof PRIORITY_ENGINE_INPUT_INVALID | typeof PRIORITY_ENGINE_POLICY_INVALID;

export class PriorityEngineError extends Error {
  readonly name = "PriorityEngineError";
  constructor(readonly code: PriorityEngineErrorCode) { super(code); }
}

const INPUT_KEYS = [
  "schema_version", "clock", "linux_policy_decision_ref", "context_policy_input", "principles", "candidates", "presentation",
] as const;
const PRINCIPLE_KEYS = [
  "kind", "principle_ref", "evidence_ref", "source_id", "source_host", "content_digest", "trust", "observed_at", "fresh_until",
  "import_gate",
] as const;
const GAP_KEYS = ["kind", "principle_ref", "source_id", "source_host", "state", "checked_at"] as const;
const IMPORT_KEYS = ["gate_id", "state", "decision_ref", "decision_host"] as const;
const CANDIDATE_KEYS = [
  "action_id", "execution_mode", "owner_safety_gate", "owner_gate_ref", "customer_impact", "deadline", "dependency",
  "irreversible_risk", "effort_cost", "principle_ref", "current_evidence_ref", "stable_identity",
] as const;
const DEADLINE_KEYS = ["due_at", "evidence_ref", "observed_at", "fresh_until"] as const;
const PRESENTATION_KEYS = ["model_disagrees", "model_preferred_action_ids", "mac_evidence_refs"] as const;
const HOSTS = ["linux-second-brain", "mac-client", "phone-client"] as const;

const fail = (): never => { throw new PriorityEngineError(PRIORITY_ENGINE_INPUT_INVALID); };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return fail();
  }
  return value;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
}
function list(value: unknown, maximum = 64): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return fail();
  }
  return value;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function instant(value: unknown): string {
  const parsed = text(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed)) || new Date(Date.parse(parsed)).toISOString() !== parsed) return fail();
  return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, choices: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return choices.find(candidate => candidate === value) ?? fail();
}
function digest(value: unknown): string | null {
  const parsed = nullableText(value);
  if (parsed !== null && !/^sha256:[0-9a-f]{64}$/.test(parsed)) return fail();
  return parsed;
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }

function parsePrinciple(value: unknown, clock: string): PriorityPrincipleSource {
  const input = record(value);
  const kind = choice(input["kind"], ["evidence", "gap"] as const);
  switch (kind) {
    case "gap": {
      closed(input, GAP_KEYS);
      const checkedAt = instant(input["checked_at"]);
      if (Date.parse(checkedAt) > Date.parse(clock)) return fail();
      return {
        kind,
        principle_ref: text(input["principle_ref"]),
        source_id: text(input["source_id"], 128),
        source_host: choice(input["source_host"], HOSTS),
        state: choice(input["state"], ["no_data", "stale", "offline", "unavailable"] as const),
        checked_at: checkedAt,
      };
    }
    case "evidence": {
      closed(input, PRINCIPLE_KEYS);
      const observedAt = instant(input["observed_at"]);
      const freshUntil = instant(input["fresh_until"]);
      if (Date.parse(observedAt) > Date.parse(clock) || Date.parse(freshUntil) <= Date.parse(observedAt)) return fail();
      const gate = record(input["import_gate"]);
      closed(gate, IMPORT_KEYS);
      return {
        kind,
        principle_ref: text(input["principle_ref"]),
        evidence_ref: nullableText(input["evidence_ref"]),
        source_id: text(input["source_id"], 128),
        source_host: choice(input["source_host"], HOSTS),
        content_digest: digest(input["content_digest"]),
        trust: choice(input["trust"], ["user_confirmed", "inferred", "untrusted", "unconfirmed"] as const),
        observed_at: observedAt,
        fresh_until: freshUntil,
        import_gate: {
          gate_id: text(gate["gate_id"], 128),
          state: choice(gate["state"], ["approved", "required"] as const),
          decision_ref: nullableText(gate["decision_ref"]),
          decision_host: choice(gate["decision_host"], ["linux-control-plane", "mac-client", "phone-client"] as const),
        },
      };
    }
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}
function parseDeadline(value: unknown, clock: string): PriorityDeadline | null {
  if (value === null) return null;
  const input = record(value);
  closed(input, DEADLINE_KEYS);
  const observedAt = instant(input["observed_at"]);
  const freshUntil = instant(input["fresh_until"]);
  if (Date.parse(observedAt) > Date.parse(clock) || Date.parse(freshUntil) <= Date.parse(observedAt)) return fail();
  return {
    due_at: instant(input["due_at"]), evidence_ref: nullableText(input["evidence_ref"]),
    observed_at: observedAt, fresh_until: freshUntil,
  };
}
function parseDependency(value: unknown): PriorityDependency {
  const input = record(value);
  const kind = choice(input["kind"], ["non_blocking", "blocks_customer", "blocks_work"] as const);
  switch (kind) {
    case "non_blocking": closed(input, ["kind"]); return { kind };
    case "blocks_customer": case "blocks_work":
      closed(input, ["kind", "evidence_ref"]);
      return { kind, evidence_ref: nullableText(input["evidence_ref"]) };
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}
function parseIdentity(value: unknown): PriorityStableIdentity | null {
  if (value === null) return null;
  const input = record(value);
  closed(input, ["key", "evidence_ref"]);
  return { key: text(input["key"]), evidence_ref: nullableText(input["evidence_ref"]) };
}
function parseCandidate(value: unknown, clock: string): PriorityCandidateAction {
  const input = record(value);
  closed(input, CANDIDATE_KEYS);
  return {
    action_id: text(input["action_id"]),
    execution_mode: choice(input["execution_mode"], ["jarvis", "delegated"] as const),
    owner_safety_gate: choice(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    owner_gate_ref: nullableText(input["owner_gate_ref"]),
    customer_impact: choice(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline: parseDeadline(input["deadline"], clock),
    dependency: parseDependency(input["dependency"]),
    irreversible_risk: choice(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: choice(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    principle_ref: nullableText(input["principle_ref"]),
    current_evidence_ref: nullableText(input["current_evidence_ref"]),
    stable_identity: parseIdentity(input["stable_identity"]),
  };
}
function parsePresentation(value: unknown): void {
  const input = record(value);
  closed(input, PRESENTATION_KEYS);
  boolean(input["model_disagrees"]);
  list(input["model_preferred_action_ids"], 32).map(item => text(item));
  list(input["mac_evidence_refs"], 32).map(item => text(item));
}

export function parsePriorityEngineInput(value: unknown): ParsedPriorityEngineInput {
  const input = record(value);
  closed(input, INPUT_KEYS);
  if (input["schema_version"] !== 1) return fail();
  const clock = instant(input["clock"]);
  let context;
  try { context = parseContextPolicyInput(input["context_policy_input"]); }
  catch (error) { if (error instanceof ContextPolicyError) return fail(); throw error; }
  if (context.clock !== clock) return fail();
  const principles = list(input["principles"], 16).map(item => parsePrinciple(item, clock));
  const candidates = list(input["candidates"], 32).map(item => parseCandidate(item, clock));
  parsePresentation(input["presentation"]);
  if (principles.length === 0 || candidates.length === 0
    || new Set(principles.map(item => item.principle_ref)).size !== principles.length
    || new Set(candidates.map(item => item.action_id)).size !== candidates.length) return fail();
  return {
    clock,
    linux_policy_decision_ref: nullableText(input["linux_policy_decision_ref"]),
    context_policy_input: context,
    principles,
    candidates,
  };
}
