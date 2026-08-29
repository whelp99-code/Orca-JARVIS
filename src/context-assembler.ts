import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { selectWithinBudgets } from "./context-assembler-budget.js";
import { classifyContextSources } from "./context-assembler-sources.js";
import {
  CONTEXT_ASSEMBLER_INPUT_INVALID,
  ContextAssemblerError,
  parseContextAssemblerInput,
  type ContextAssemblerInput,
  type MemoryEvidenceInput,
} from "./context-assembler-input.js";
import type { ContextSnapshotV1, ObservationEnvelopeV1 } from "./personal-contracts.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "./personal-validation.js";

export {
  CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE,
  CONTEXT_ASSEMBLER_INPUT_INVALID,
  ContextAssemblerError,
  type ContextAssemblerErrorCode,
  type ContextAssemblerInput,
  type ContextBudget,
  type MemoryEvidenceInput,
  type MemoryGapInput,
  type MemoryInput,
} from "./context-assembler-input.js";

type RawEvidence = {
  readonly evidence_id: string;
  readonly digest: string;
  readonly kind: string;
  readonly source_id: string;
  readonly observed_at: string;
};

const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function uuid(value: unknown): string {
  const hex = createHash("sha256").update(canonicalize(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const addMilliseconds = (instant: string, milliseconds: number): string => new Date(Date.parse(instant) + milliseconds).toISOString();

function observationEvidence(observation: ObservationEnvelopeV1): RawEvidence {
  const digest = canonicalPersonalContractHash(observation);
  return {
    evidence_id: `evi:pos:v1:${uuid({ digest, reference: observation.id })}`,
    digest,
    kind: "context_observation",
    source_id: observation.source.source_id,
    observed_at: observation.observed_at,
  };
}
function memoryEvidence(memory: MemoryEvidenceInput): RawEvidence {
  return {
    evidence_id: `evi:pos:v1:${uuid({ digest: memory.digest, reference: memory.memory_ref })}`,
    digest: memory.digest,
    kind: "confirmed_memory",
    source_id: memory.source_id,
    observed_at: memory.observed_at,
  };
}

export function assemblePersonalContext(input: ContextAssemblerInput): ContextSnapshotV1;
export function assemblePersonalContext(input: unknown): ContextSnapshotV1;
export function assemblePersonalContext(input: unknown): ContextSnapshotV1 {
  const parsed = parseContextAssemblerInput(input);
  const sources = classifyContextSources(parsed.observations, parsed.memories, parsed.clock);
  const observations = sources.observations;
  const selection = selectWithinBudgets({
    purpose: parsed.purpose, query: parsed.query, budgets: parsed.budgets,
    observations, memories: sources.memories, authority: [...parsed.pending_authority_refs].sort(),
    excluded: sources.excluded, conflicts: sources.conflicts, omissions: sources.omissions,
    sufficient: !sources.criticalGap,
  });
  const payload = selection.payload;
  const selectedMemories = selection.memories;
  const evidence = [...selection.observations.map(observationEvidence), ...selectedMemories.map(memoryEvidence)];
  const requestedExpiry = addMilliseconds(parsed.clock, parsed.expires_in_ms);
  const deadlines = [
    requestedExpiry,
    ...selection.observations.flatMap(item => [item.freshness.fresh_until, item.expires_at]),
    ...selectedMemories.map(item => item.fresh_until),
  ].sort();
  const expiresAt = deadlines[0];
  if (expiresAt === undefined || Date.parse(expiresAt) <= Date.parse(parsed.clock)) {
    throw new ContextAssemblerError(CONTEXT_ASSEMBLER_INPUT_INVALID);
  }
  const observedAt = evidence.map(item => item.observed_at).sort().at(-1) ?? parsed.clock;
  const identity = uuid({ clock: parsed.clock, evidence, expires_at: expiresAt, payload });
  const seedDigest = hash({ identity, payload });
  return parseContextSnapshotV1({
    schema_version: 1,
    id: `ctx:pos:v1:${identity}`,
    created_at: parsed.clock,
    observed_at: observedAt,
    valid_at: observedAt,
    source: {
      source_id: "src:pos:v1:jarvis:context-assembler",
      source_kind: "authority",
      host_id: "host:pos:linux-control-plane",
      source_version: "context-assembler-v1",
      evidence_ref: seedDigest,
    },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: {
      state: payload.state === "sufficient" ? "fresh" : "unavailable",
      checked_at: parsed.clock,
      fresh_until: addMilliseconds(expiresAt, -1),
    },
    expires_at: expiresAt,
    idempotency_key: `idem:pos:v1:context:${seedDigest.slice(7)}`,
    correlation_id: `corr:pos:v1:${uuid({ purpose: parsed.purpose, query: parsed.query })}`,
    causation_id: null,
    payload,
    policy_decision: {
      decision: payload.state === "sufficient" ? "allow" : "abstain",
      policy_version: "context-assembler-v1",
      reason_codes: payload.state === "sufficient" ? ["POLICY_SATISFIED"] : ["EVIDENCE_INSUFFICIENT"],
    },
    evidence,
    receipt: null,
  });
}
