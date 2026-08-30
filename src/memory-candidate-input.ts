import { canonicalize } from "./canonical.js";
import { containsMemorySecret } from "./memory-candidate-private.js";
import { parseMemoryCandidateSource, parseMemoryReferences } from "./memory-candidate-source.js";
import {
  MEMORY_CANDIDATE_CONFLICT_STATES,
  MEMORY_CANDIDATE_OPERATIONS,
  MEMORY_CANDIDATE_POLICY_SENSITIVITIES,
  type ParsedMemoryCandidateInput,
  type ParsedMemoryConflict,
  type ParsedSecondBrainState,
} from "./memory-candidate-types.js";
import {
  memoryArray,
  memoryFail,
  memoryInstant,
  memoryMember,
  memoryRecord,
  memoryText,
} from "./memory-candidate-values.js";

const INPUT_KEYS = [
  "schema_version", "idempotency_key", "operation", "subject", "statement", "purpose", "sensitivity", "host",
  "principal_id", "payload_fields", "source", "second_brain", "conflict",
] as const;
const HOSTS = ["linux-control-plane", "linux-second-brain"] as const;

function metadataText(value: unknown): string {
  const parsed = memoryText(value, 128);
  return containsMemorySecret(parsed) ? memoryFail() : parsed;
}

function stringList(value: unknown): readonly string[] {
  const parsed = memoryArray(value, 16).map(item => memoryText(item, 128));
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length) return memoryFail();
  return parsed;
}

function secondBrainState(value: unknown): ParsedSecondBrainState {
  const input = memoryRecord(value);
  const state = memoryMember(input["state"], ["available", "no_data"] as const);
  switch (state) {
    case "available":
      memoryRecord(input, ["state"]);
      return { state };
    case "no_data": {
      memoryRecord(input, ["state", "checked_at", "fresh_until"]);
      const checkedAt = memoryInstant(input["checked_at"]);
      const freshUntil = memoryInstant(input["fresh_until"]);
      if (Date.parse(checkedAt) >= Date.parse(freshUntil)) return memoryFail();
      return { state, checked_at: checkedAt, fresh_until: freshUntil };
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function conflictState(value: unknown): ParsedMemoryConflict {
  const input = memoryRecord(value, ["state", "references"]);
  const state = memoryMember(input["state"], MEMORY_CANDIDATE_CONFLICT_STATES);
  const references = parseMemoryReferences(input["references"], state === "none");
  if ((state === "none") !== (references.length === 0)) return memoryFail();
  return { state, references };
}

export function parseMemoryCandidateInput(value: unknown): ParsedMemoryCandidateInput {
  const input = memoryRecord(value, INPUT_KEYS);
  if (input["schema_version"] !== 1) return memoryFail();
  const parsed: ParsedMemoryCandidateInput = {
    schema_version: 1,
    idempotency_key: memoryText(input["idempotency_key"], 256),
    operation: memoryMember(input["operation"], MEMORY_CANDIDATE_OPERATIONS),
    subject: memoryText(input["subject"]),
    statement: memoryText(input["statement"], 4_096),
    purpose: metadataText(input["purpose"]),
    sensitivity: memoryMember(input["sensitivity"], MEMORY_CANDIDATE_POLICY_SENSITIVITIES),
    host: memoryMember(input["host"], HOSTS),
    principal_id: metadataText(input["principal_id"]),
    payload_fields: stringList(input["payload_fields"]),
    source: parseMemoryCandidateSource(input["source"]),
    second_brain: secondBrainState(input["second_brain"]),
    conflict: conflictState(input["conflict"]),
  };
  if (Buffer.byteLength(canonicalize(parsed), "utf8") > 32_768) return memoryFail();
  return parsed;
}
