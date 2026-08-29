import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import { PersonalContractError, parseObservationEnvelopeV1 } from "./personal-validation.js";

export const CONTEXT_ASSEMBLER_INPUT_INVALID = "CONTEXT_ASSEMBLER_INPUT_INVALID" as const;
export const CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE = "CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE" as const;
export type ContextAssemblerErrorCode =
  | typeof CONTEXT_ASSEMBLER_INPUT_INVALID
  | typeof CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE;

export class ContextAssemblerError extends Error {
  readonly name = "ContextAssemblerError";
  constructor(readonly code: ContextAssemblerErrorCode) { super(code); }
}

export type ContextBudget = { readonly max_items: number; readonly max_excerpt_bytes: number; readonly max_total_bytes: number };
export type MemoryEvidenceInput = {
  readonly kind: "evidence"; readonly memory_ref: string; readonly source_id: string; readonly digest: string;
  readonly observed_at: string; readonly fresh_until: string; readonly excerpt: string;
  readonly trust: "user_confirmed" | "inferred" | "untrusted"; readonly sensitivity: "public" | "personal" | "sensitive" | "restricted";
  readonly relevance: "related" | "unrelated"; readonly relation: "supports" | "contradicts";
};
export type MemoryGapInput = { readonly kind: "gap"; readonly memory_ref: string; readonly state: "no_data" | "unavailable" | "offline" };
export type MemoryInput = MemoryEvidenceInput | MemoryGapInput;
export type ContextAssemblerInput = {
  readonly purpose: string; readonly query: string; readonly clock: string; readonly expires_in_ms: number;
  readonly budgets: ContextBudget; readonly observations: readonly ObservationEnvelopeV1[];
  readonly pending_authority_refs: readonly string[]; readonly memories: readonly MemoryInput[];
};

const INPUT_KEYS = [
  "purpose", "query", "clock", "expires_in_ms", "budgets", "observations", "pending_authority_refs", "memories",
] as const;
const EVIDENCE_KEYS = [
  "kind", "memory_ref", "source_id", "digest", "observed_at", "fresh_until", "excerpt", "trust", "sensitivity", "relevance", "relation",
] as const;
const GAP_KEYS = ["kind", "memory_ref", "state"] as const;
const BUDGET_KEYS = ["max_items", "max_excerpt_bytes", "max_total_bytes"] as const;

function fail(code: ContextAssemblerErrorCode = CONTEXT_ASSEMBLER_INPUT_INVALID): never { throw new ContextAssemblerError(code); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
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
  const actual = Object.keys(value); if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) return fail();
  const keys = Reflect.ownKeys(value); if (keys.length !== value.length + 1 || !keys.includes("length")) return fail();
  for (let index = 0; index < value.length; index++) {
    const key = String(index); const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || descriptor === undefined || descriptor.get !== undefined
      || descriptor.set !== undefined || !descriptor.enumerable) return fail();
  }
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || Buffer.byteLength(value, "utf8") > maximum) return fail();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail(); return value;
}
function instant(value: unknown): string {
  const parsed = text(value, 32); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed)) || new Date(Date.parse(parsed)).toISOString() !== parsed) return fail(); return parsed;
}
function choice<const Values extends readonly string[]>(value: unknown, choices: Values): Values[number] {
  if (typeof value !== "string") return fail(); const found = choices.find(item => item === value); return found ?? fail();
}
function memory(value: unknown): MemoryInput {
  const input = record(value); const kind = choice(input["kind"], ["evidence", "gap"] as const);
  switch (kind) {
    case "gap":
      closed(input, GAP_KEYS);
      return {
        kind,
        memory_ref: text(input["memory_ref"], 512),
        state: choice(input["state"], ["no_data", "unavailable", "offline"] as const),
      };
    case "evidence": {
      closed(input, EVIDENCE_KEYS); const source = text(input["source_id"], 128); const digest = text(input["digest"], 71);
      if (!/^src:pos:v1:second-brain:[a-z0-9][a-z0-9-]{0,63}$/.test(source)
        || !/^sha256:[0-9a-f]{64}$/.test(digest)) return fail();
      const observed = instant(input["observed_at"]);
      const fresh = instant(input["fresh_until"]);
      if (Date.parse(fresh) <= Date.parse(observed)) return fail();
      return {
        kind,
        memory_ref: text(input["memory_ref"], 512),
        source_id: source,
        digest,
        observed_at: observed,
        fresh_until: fresh,
        excerpt: text(input["excerpt"], 4_096),
        trust: choice(input["trust"], ["user_confirmed", "inferred", "untrusted"] as const),
        sensitivity: choice(input["sensitivity"], ["public", "personal", "sensitive", "restricted"] as const),
        relevance: choice(input["relevance"], ["related", "unrelated"] as const),
        relation: choice(input["relation"], ["supports", "contradicts"] as const),
      };
    }
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

export function parseContextAssemblerInput(value: unknown): ContextAssemblerInput {
  const input = record(value);
  closed(input, INPUT_KEYS);
  const budgetsValue = record(input["budgets"]);
  closed(budgetsValue, BUDGET_KEYS);
  const budgets = {
    max_items: integer(budgetsValue["max_items"], 1, 32),
    max_excerpt_bytes: integer(budgetsValue["max_excerpt_bytes"], 1, 4_096),
    max_total_bytes: integer(budgetsValue["max_total_bytes"], 1, 65_536),
  };
  const query = text(input["query"], 4_096); if (Buffer.byteLength(query, "utf8") > budgets.max_excerpt_bytes) fail();
  let observations: readonly ObservationEnvelopeV1[];
  try { observations = list(input["observations"]).map(item => parseObservationEnvelopeV1(item)); }
  catch (error) { if (error instanceof PersonalContractError) return fail(); throw error; }
  const authority = list(input["pending_authority_refs"]).map(item => text(item, 512));
  const memories = list(input["memories"]).map(memory);
  if (new Set(authority).size !== authority.length
    || new Set(memories.map(item => item.memory_ref)).size !== memories.length) fail();
  return {
    purpose: text(input["purpose"], 128),
    query,
    clock: instant(input["clock"]),
    expires_in_ms: integer(input["expires_in_ms"], 2, 3_600_000),
    budgets,
    observations,
    pending_authority_refs: authority,
    memories,
  };
}
