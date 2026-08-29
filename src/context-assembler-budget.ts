import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE,
  ContextAssemblerError,
  type ContextBudget,
  type MemoryEvidenceInput,
} from "./context-assembler-input.js";
import type { ContextPayloadV1, ObservationEnvelopeV1 } from "./personal-contracts.js";

type BudgetSelection = {
  readonly payload: ContextPayloadV1;
  readonly observations: readonly ObservationEnvelopeV1[];
  readonly memories: readonly MemoryEvidenceInput[];
};
type SelectionInput = {
  readonly purpose: string; readonly query: string; readonly budgets: ContextBudget;
  readonly observations: readonly ObservationEnvelopeV1[]; readonly memories: readonly MemoryEvidenceInput[];
  readonly authority: readonly string[]; readonly excluded: readonly string[]; readonly conflicts: readonly string[];
  readonly omissions: readonly string[]; readonly sufficient: boolean;
};
type Candidate =
  | { readonly kind: "observation"; readonly value: ObservationEnvelopeV1 }
  | { readonly kind: "memory"; readonly value: MemoryEvidenceInput }
  | { readonly kind: "authority" | "excluded" | "conflict" | "omission"; readonly value: string };
type Accumulator = {
  /** Mutable only while deterministically assembling the bounded payload. */
  observations: ObservationEnvelopeV1[]; memories: MemoryEvidenceInput[]; authority: string[];
  excluded: string[]; conflicts: string[]; omissions: string[];
};

function token(code: string, value: unknown): string {
  const digest = createHash("sha256").update(canonicalize(value)).digest("hex").slice(0, 8); return `${code}:${digest}`;
}
function add(target: Accumulator, candidate: Candidate): void {
  switch (candidate.kind) {
    case "observation": target.observations.push(candidate.value); return;
    case "memory": target.memories.push(candidate.value); return;
    case "authority": target.authority.push(candidate.value); return;
    case "excluded": target.excluded.push(candidate.value); return;
    case "conflict": target.conflicts.push(candidate.value); return;
    case "omission": target.omissions.push(candidate.value); return;
    default: { const exhaustive: never = candidate; return exhaustive; }
  }
}
function copy(selected: Accumulator): Accumulator {
  return {
    observations: [...selected.observations],
    memories: [...selected.memories],
    authority: [...selected.authority],
    excluded: [...selected.excluded],
    conflicts: [...selected.conflicts],
    omissions: [...selected.omissions],
  };
}
function output(input: SelectionInput, selected: Accumulator, overflow: string | null): ContextPayloadV1 {
  return {
    purpose: input.purpose, query: input.query,
    included_observation_refs: selected.observations.map(item => item.id),
    included_memory_refs: selected.memories.map(item => item.memory_ref),
    excluded_refs: selected.excluded, pending_authority_refs: selected.authority,
    conflicts: selected.conflicts, omissions: [...selected.omissions, ...(overflow === null ? [] : [overflow])].sort(),
    budgets: input.budgets,
    state: input.sufficient && selected.observations.length > 0 && selected.memories.length > 0 ? "sufficient" : "insufficient",
  };
}
function within(payload: ContextPayloadV1): boolean {
  const count = payload.included_observation_refs.length + payload.included_memory_refs.length + payload.excluded_refs.length
    + payload.pending_authority_refs.length + payload.conflicts.length + payload.omissions.length;
  return count <= payload.budgets.max_items && Buffer.byteLength(canonicalize(payload), "utf8") <= payload.budgets.max_total_bytes;
}
function candidates(input: SelectionInput): readonly Candidate[] {
  const oversized = input.memories.filter(item => Buffer.byteLength(item.excerpt, "utf8") > input.budgets.max_excerpt_bytes);
  const excerpt = oversized.length === 0 ? [] : [token("EXCERPT_TRUNCATED", oversized.map(item => item.memory_ref))];
  const firstObservations = input.observations.slice(0, 1).map(value => ({ kind: "observation", value }) satisfies Candidate);
  const firstMemories = input.memories.slice(0, 1).map(value => ({ kind: "memory", value }) satisfies Candidate);
  return [
    ...firstObservations, ...firstMemories,
    ...input.authority.map(value => ({ kind: "authority", value }) satisfies Candidate),
    ...input.excluded.map(value => ({ kind: "excluded", value }) satisfies Candidate),
    ...input.conflicts.map(value => ({ kind: "conflict", value }) satisfies Candidate),
    ...input.omissions.map(value => ({ kind: "omission", value }) satisfies Candidate),
    ...excerpt.map(value => ({ kind: "omission", value }) satisfies Candidate),
    ...input.observations.slice(1).map(value => ({ kind: "observation", value }) satisfies Candidate),
    ...input.memories.slice(1).map(value => ({ kind: "memory", value }) satisfies Candidate),
  ];
}

export function selectWithinBudgets(input: SelectionInput): BudgetSelection {
  const all = candidates(input); const overflow = token("BUDGET_OVERFLOW", all.map(item => item.kind));
  if ([overflow, ...input.conflicts, ...input.omissions].some(item => Buffer.byteLength(item, "utf8") > input.budgets.max_excerpt_bytes)) {
    throw new ContextAssemblerError(CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE);
  }
  const selected: Accumulator = { observations: [], memories: [], authority: [], excluded: [], conflicts: [], omissions: [] };
  let overflowed = false;
  for (let index = 0; index < all.length; index++) {
    const candidate = all[index]; if (candidate === undefined) continue;
    const trial = copy(selected); add(trial, candidate);
    const reserveOverflow = overflowed || index + 1 < all.length;
    if (within(output(input, trial, reserveOverflow ? overflow : null))) Object.assign(selected, trial); else overflowed = true;
  }
  const payload = output(input, selected, overflowed ? overflow : null);
  if (!within(payload)) throw new ContextAssemblerError(CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE);
  return { payload, observations: selected.observations, memories: selected.memories };
}
