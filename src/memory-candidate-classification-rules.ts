import type { MemoryPolicyOutcome } from "./memory-candidate-policy.js";
import { containsMemoryPromptText, containsMemorySecret } from "./memory-candidate-private.js";
import {
  MEMORY_CANDIDATE_CONFIRMATION_GATE,
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateClassification,
  type MemoryCandidateConfidence,
  type MemoryCandidateKind,
  type MemoryCandidateReasonCode,
  type MemoryCandidateState,
  type MemoryCandidateStorageSensitivity,
  type ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";

export type MemoryRuleContext = {
  readonly input: ParsedMemoryCandidateInput;
  readonly content_digest: string;
  readonly approved_decision_valid: boolean;
  readonly policy: MemoryPolicyOutcome;
};
export type MemoryDisposition = Pick<MemoryCandidateClassification,
  "state" | "classification_reason" | "required_confirmation" | "confirmation_gate" | "delivery">;

function sourceReason(context: MemoryRuleContext): MemoryCandidateReasonCode | null {
  const { input, content_digest: contentDigest } = context;
  const source = input.source;
  switch (source.input_class) {
    case "raw_transcript": return "RAW_TRANSCRIPT_REJECTED";
    case "worker_assertion": return "WORKER_ASSERTION_REJECTED";
    case "unverified_summary": return "UNVERIFIED_SUMMARY_REJECTED";
    case "transient_runtime": return "TRANSIENT_RUNTIME_REJECTED";
    case "unlabeled_trait_inference": return "UNLABELED_TRAIT_INFERENCE_REJECTED";
    case "model_assertion": return "MODEL_AUTHORITY_REJECTED";
    case "explicit_user_instruction": {
      const instruction = source.references[0];
      const session = source.references[1];
      if (instruction === undefined || session === undefined || source.instruction_id === null
        || source.principal_id !== input.principal_id || source.authenticated_session_id === null) {
        return "OWNER_PROVENANCE_INVALID";
      }
      const expected = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.instruction, {
        instruction_id: source.instruction_id,
        principal_id: source.principal_id,
        authenticated_session_id: source.authenticated_session_id,
        statement: input.statement,
        session_evidence: session,
      });
      return instruction.evidence_digest === expected ? null : "OWNER_PROVENANCE_INVALID";
    }
    case "verified_outcome": {
      const verification = source.references[0];
      const artifact = source.references[1];
      if (verification === undefined || artifact === undefined || source.outcome_id === null
        || source.worker_id === null || source.verifier_id === null || source.worker_id === source.verifier_id
        || source.verdict !== "passed" || source.machine_outcome !== "succeeded") return "UNVERIFIED_OUTCOME";
      const expected = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.verification, {
        outcome_id: source.outcome_id,
        worker_id: source.worker_id,
        verifier_id: source.verifier_id,
        verdict: source.verdict,
        machine_outcome: source.machine_outcome,
        content_digest: contentDigest,
        artifact,
      });
      return verification.evidence_digest === expected ? null : "UNVERIFIED_OUTCOME";
    }
    case "approved_decision":
      return context.approved_decision_valid && source.principal_id === input.principal_id
        ? null : "APPROVAL_RECEIPT_INVALID";
    case "labeled_inference":
      return source.inference_label === "inference" && source.references.length > 0
        ? null : "INFERENCE_PROVENANCE_INVALID";
    default: {
      const exhaustive: never = source.input_class;
      return exhaustive;
    }
  }
}

function conflictReason(input: ParsedMemoryCandidateInput, contentDigest: string): MemoryCandidateReasonCode | null {
  const { state, references } = input.conflict;
  switch (state) {
    case "none": return null;
    case "conflict": return "OPEN_CONFLICT";
    case "same":
      return references.length === 1 && references[0]?.kind === "existing_memory"
        && references[0].evidence_digest === contentDigest ? null : "CONFLICT_DECLARATION_INVALID";
    case "supersede":
      return input.operation === "correct" && references.length === 1
        && references[0]?.kind === "existing_memory" ? null : "CONFLICT_DECLARATION_INVALID";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function issue(context: MemoryRuleContext): MemoryCandidateReasonCode | null {
  const { input, policy } = context;
  if (containsMemoryPromptText(input.statement) || containsMemoryPromptText(input.subject)) {
    return "PROMPT_TEXT_REJECTED";
  }
  if (containsMemorySecret(input.statement) || containsMemorySecret(input.subject)) return "PROHIBITED_CONTENT";
  if (policy.reason !== null && policy.reason !== "POLICY_DENIED") return policy.reason;
  return sourceReason(context) ?? conflictReason(input, context.content_digest) ?? policy.reason;
}

function confirmationReason(input: ParsedMemoryCandidateInput): MemoryCandidateReasonCode {
  if (input.conflict.state === "supersede") return "SUPERSEDE_CONFIRMATION_REQUIRED";
  if (input.operation === "correct") return "CORRECTION_CONFIRMATION_REQUIRED";
  if (input.source.input_class === "labeled_inference") return "LABELED_INFERENCE_CONFIRMATION_REQUIRED";
  return "SENSITIVE_MEMORY_CONFIRMATION_REQUIRED";
}

function approvedReason(input: ParsedMemoryCandidateInput): MemoryCandidateReasonCode {
  switch (input.source.input_class) {
    case "explicit_user_instruction": return "EXPLICIT_OWNER_INSTRUCTION_APPROVED";
    case "verified_outcome": return "VERIFIED_OUTCOME_APPROVED";
    case "approved_decision": return "APPROVED_DECISION_APPROVED";
    case "labeled_inference": return "LABELED_INFERENCE_CONFIRMATION_REQUIRED";
    case "raw_transcript": return "RAW_TRANSCRIPT_REJECTED";
    case "worker_assertion": return "WORKER_ASSERTION_REJECTED";
    case "unverified_summary": return "UNVERIFIED_SUMMARY_REJECTED";
    case "transient_runtime": return "TRANSIENT_RUNTIME_REJECTED";
    case "unlabeled_trait_inference": return "UNLABELED_TRAIT_INFERENCE_REJECTED";
    case "model_assertion": return "MODEL_AUTHORITY_REJECTED";
    default: {
      const exhaustive: never = input.source.input_class;
      return exhaustive;
    }
  }
}

export function memoryCandidateDisposition(context: MemoryRuleContext): MemoryDisposition {
  const { input, policy } = context;
  const problem = issue(context);
  const semanticConfirmation = input.sensitivity === "sensitive" || input.sensitivity === "restricted"
    || input.source.input_class === "labeled_inference" || input.operation === "correct"
    || input.conflict.state === "supersede" || policy.status === "confirm";
  const terminal = problem !== null && policy.status !== "no_data";
  const state: MemoryCandidateState = terminal ? (policy.status === "expired" ? "expired" : "rejected")
    : policy.status === "no_data" ? "classified" : semanticConfirmation ? "awaiting_confirmation" : "approved";
  const requiredConfirmation = !terminal && semanticConfirmation;
  const reason = problem ?? (policy.status === "no_data" ? "SECOND_BRAIN_NO_DATA"
    : requiredConfirmation ? confirmationReason(input) : approvedReason(input));
  return {
    state,
    classification_reason: reason,
    required_confirmation: requiredConfirmation,
    confirmation_gate: requiredConfirmation ? MEMORY_CANDIDATE_CONFIRMATION_GATE : null,
    delivery: state === "classified" ? { state: "pending", reason: "SECOND_BRAIN_NO_DATA" }
      : state === "approved" ? { state: "not_created", reason: null } : { state: "blocked", reason },
  };
}

export function memoryCandidateKind(input: ParsedMemoryCandidateInput): MemoryCandidateKind {
  if (input.operation === "correct") return "correction";
  switch (input.source.input_class) {
    case "explicit_user_instruction": return "user_instruction";
    case "labeled_inference": case "unlabeled_trait_inference": case "model_assertion": return "inference";
    case "verified_outcome": case "approved_decision": case "raw_transcript": case "worker_assertion":
    case "unverified_summary": case "transient_runtime": return "verified_fact";
    default: {
      const exhaustive: never = input.source.input_class;
      return exhaustive;
    }
  }
}

export function memoryStorageSensitivity(input: ParsedMemoryCandidateInput): MemoryCandidateStorageSensitivity {
  switch (input.sensitivity) {
    case "public": case "personal": return "normal";
    case "sensitive": return "sensitive";
    case "restricted": return "restricted";
    default: {
      const exhaustive: never = input.sensitivity;
      return exhaustive;
    }
  }
}

export function memoryCandidateConfidence(input: ParsedMemoryCandidateInput): MemoryCandidateConfidence {
  switch (input.source.input_class) {
    case "explicit_user_instruction": return "confirmed";
    case "labeled_inference": case "unlabeled_trait_inference": case "model_assertion": return "inferred";
    case "verified_outcome": case "approved_decision": case "raw_transcript": case "worker_assertion":
    case "unverified_summary": case "transient_runtime": return "verified";
    default: {
      const exhaustive: never = input.source.input_class;
      return exhaustive;
    }
  }
}
