import { describe, expect, it } from "vitest";
import {
  classifyMemoryCandidate,
  MEMORY_CANDIDATE_CONFIRMATION_GATE,
  MEMORY_CANDIDATE_REASON_CODES,
} from "../../src/memory-candidates.js";
import {
  approvedDecisionMemoryInput,
  evidenceRef,
  explicitMemoryInput,
  inferredMemoryInput,
  memoryPolicy,
  MEMORY_NOW,
  REJECTED_SOURCE_CLASSES,
  rejectedMemoryInput,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("record required");
  return value;
}

function sourceReferences(value: Record<string, unknown>): Record<string, unknown>[] {
  const source = record(value["source"]);
  const references = source["references"];
  if (!Array.isArray(references)) throw new TypeError("references required");
  return references.map(record);
}

function classify(value: unknown, now = MEMORY_NOW) {
  return classifyMemoryCandidate(memoryPolicy(), value, new Date(now));
}

function policyWithMemoryRetention(days: number): unknown {
  const policy = structuredClone(memoryPolicy());
  const classes = record(record(policy)["data_classes"]);
  record(classes["memory"])["retention_days"] = days;
  return policy;
}

describe("Task 27 deterministic memory candidate policy", () => {
  it("auto-stages a verified technical outcome with ordered exact provenance", () => {
    // Given: an independently verified machine outcome bound to verification and artifact evidence.
    const input = verifiedMemoryInput();

    // When: the current personal memory policy classifies it.
    const result = classify(input);

    // Then: verified normal memory is approved without creating confirmation authority.
    expect(result).toMatchObject({
      schema_version: 1,
      input_class: "verified_outcome",
      operation: "remember",
      confidence: "verified",
      policy_sensitivity: "personal",
      storage_sensitivity: "normal",
      purpose: "personal_memory",
      retention_days: 3650,
      required_confirmation: false,
      confirmation_gate: null,
      state: "approved",
      classification_reason: "VERIFIED_OUTCOME_APPROVED",
      delivery: { state: "not_created", reason: null },
    });
    expect(result.source_refs.map(reference => reference.kind)).toEqual(["verification", "artifact"]);
    expect(result.source_refs.map(reference => reference.position)).toEqual([0, 1]);
    expect(result.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.subject_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.source_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.classification_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.policy_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.dedup_key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("auto-stages an exact owner instruction as confirmed", () => {
    // Given: one instruction with exact owner and authenticated-session evidence.
    const input = explicitMemoryInput();

    // When: it is classified.
    const result = classify(input);

    // Then: owner provenance determines confirmed confidence and approval.
    expect(result).toMatchObject({
      input_class: "explicit_user_instruction",
      confidence: "confirmed",
      state: "approved",
      classification_reason: "EXPLICIT_OWNER_INSTRUCTION_APPROVED",
      source: {
        principal_id: "principal:owner",
        authenticated_session_id: "session:owner:task27",
      },
    });
    expect(result.source_refs.map(reference => reference.kind)).toEqual(["owner_instruction", "owner_session"]);
  });

  it("requires confirmation for sensitive memory, every inference, correction, and supersession", () => {
    // Given: independently valid candidates in each confirmation-required class.
    const values = [
      explicitMemoryInput({ sensitivity: "sensitive", idempotency_key: "candidate:sensitive" }),
      inferredMemoryInput(),
      verifiedMemoryInput({ operation: "correct", idempotency_key: "candidate:correct" }),
      verifiedMemoryInput({
        operation: "correct",
        idempotency_key: "candidate:supersede",
        conflict: {
          state: "supersede",
          references: [evidenceRef("existing_memory", "memory:existing")],
        },
      }),
    ];

    // When: each candidate is classified.
    const results = values.map(value => classify(value));

    // Then: none auto-approves and every result binds the exact policy gate.
    expect(results.every(result => result.state === "awaiting_confirmation")).toBe(true);
    expect(results.every(result => result.required_confirmation)).toBe(true);
    expect(results.every(result => result.confirmation_gate === MEMORY_CANDIDATE_CONFIRMATION_GATE)).toBe(true);
    expect(results[0]).toMatchObject({ policy_sensitivity: "sensitive", storage_sensitivity: "sensitive" });
    expect(results[1]).toMatchObject({ confidence: "inferred", storage_sensitivity: "normal" });
    expect(results[3]).toMatchObject({ conflict_state: "supersede", classification_reason: "SUPERSEDE_CONFIRMATION_REQUIRED" });
  });

  it("never trusts caller-provided approved-decision receipt facts", () => {
    // Given: well-formed approved-decision fields without an authority database lookup.
    const input = approvedDecisionMemoryInput();

    // When: the pure classifier has no authority-side receipt reader.
    const result = classify(input);

    // Then: it fails closed; only MemoryCandidateStore may validate and auto-stage the receipt.
    expect(result).toMatchObject({
      input_class: "approved_decision",
      confidence: "verified",
      state: "rejected",
      classification_reason: "APPROVAL_RECEIPT_INVALID",
      source: {
        request_id: "request:task27:decision",
        receipt_id: "receipt:task27:decision",
        command_digest: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(Object.keys(result)).not.toContain("receipt");
  });

  it("classifies current no-data input but stops before approval or delivery creation", () => {
    // Given: valid source provenance and a current explicit Second Brain no-data result.
    const input = verifiedMemoryInput({
      second_brain: {
        state: "no_data",
        checked_at: MEMORY_NOW,
        fresh_until: "2026-08-28T12:01:00.000Z",
      },
    });

    // When: policy evaluates no-data independently from source validity.
    const result = classify(input);

    // Then: the candidate is classified and delivery remains pending with the frozen code.
    expect(result).toMatchObject({
      state: "classified",
      classification_reason: "SECOND_BRAIN_NO_DATA",
      delivery: { state: "pending", reason: "SECOND_BRAIN_NO_DATA" },
    });
  });

  it.each(REJECTED_SOURCE_CLASSES)("rejects unsupported source class %s as an immutable audit result", sourceClass => {
    // Given: bounded data labeled as a prohibited source class.
    const input = rejectedMemoryInput(sourceClass);

    // When: classification runs without treating its prose as authority.
    const result = classify(input);

    // Then: the result is terminal and cannot be auto-approved.
    expect(result.state).toBe("rejected");
    expect(result.delivery.state).toBe("blocked");
    expect(MEMORY_CANDIDATE_REASON_CODES).toContain(result.classification_reason);
  });

  it("fails closed at freshness, provenance expiry, policy expiry, and retention equality", () => {
    // Given: exact expiration boundaries viewed at -1, equality, and +1 millisecond.
    const boundary = "2026-08-28T12:00:00.000Z";
    const times = [
      ["2026-08-28T11:59:59.999Z", "approved"],
      [boundary, "rejected"],
      ["2026-08-28T12:00:00.001Z", "rejected"],
    ] as const;

    // When/Then: freshness accepts only the instant strictly before expiry.
    for (const [now, state] of times) {
      const input = inferredMemoryInput();
      for (const reference of sourceReferences(input)) reference["fresh_until"] = boundary;
      expect(classifyMemoryCandidate(memoryPolicy(), input, new Date(now)).state).toBe(state === "approved" ? "awaiting_confirmation" : state);
    }

    // When/Then: source expiry also fails at equality and after it.
    for (const [now, state] of times) {
      const input = inferredMemoryInput();
      for (const reference of sourceReferences(input)) {
        reference["fresh_until"] = boundary;
        reference["expires_at"] = boundary;
      }
      expect(classifyMemoryCandidate(memoryPolicy(), input, new Date(now)).state)
        .toBe(state === "approved" ? "awaiting_confirmation" : "expired");
    }

    // When/Then: current policy validity is half-open at its expiry.
    for (const [now, state] of times) {
      const policy = structuredClone(memoryPolicy());
      record(policy)["expires_at"] = boundary;
      expect(classifyMemoryCandidate(policy, verifiedMemoryInput(), new Date(now)).state).toBe(state);
    }

    // When/Then: assigned retention is also half-open at candidate expiry.
    for (const [now, state] of times) {
      const input = inferredMemoryInput();
      for (const reference of sourceReferences(input)) {
        reference["observed_at"] = "2026-08-27T12:00:00.000Z";
        reference["fresh_until"] = "2026-08-29T12:00:00.000Z";
        reference["expires_at"] = "2026-08-30T12:00:00.000Z";
      }
      expect(classifyMemoryCandidate(policyWithMemoryRetention(1), input, new Date(now)).state)
        .toBe(state === "approved" ? "awaiting_confirmation" : "expired");
    }
  });

  it("binds source order and cardinality into deterministic source and candidate identities", () => {
    // Given: the same labeled inference with two ordered evidence references.
    const first = inferredMemoryInput();
    const source = record(first["source"]);
    source["references"] = [
      evidenceRef("inference_evidence", "inference-evidence:first"),
      evidenceRef("inference_evidence", "inference-evidence:second"),
    ];
    const reversed = structuredClone(first);
    record(reversed["source"])["references"] = [...sourceReferences(reversed)].reverse();

    // When: each ordering is classified twice.
    const one = classify(first);
    const replay = classify(structuredClone(first));
    const two = classify(reversed);

    // Then: exact bytes are stable and changed order produces a different identity.
    expect(replay).toEqual(one);
    expect(two.source_digest).not.toBe(one.source_digest);
    expect(two.dedup_key).not.toBe(one.dedup_key);
    expect(two.candidate_id).not.toBe(one.candidate_id);
  });
});
