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
  it("keeps a caller-declared verified outcome provisional", () => {
    // Given: a closed pointer to evidence that the pure classifier cannot query.
    const result = classify(verifiedMemoryInput());

    // Then: identity and policy digests are deterministic, but only the store may resolve verifier authority.
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
      state: "rejected",
      classification_reason: "UNVERIFIED_OUTCOME",
      delivery: { state: "blocked", reason: "UNVERIFIED_OUTCOME" },
    });
    expect(result.source_refs).toEqual([]);
    for (const digest of [result.content_digest, result.subject_digest, result.source_digest, result.candidate_digest,
      result.classification_digest, result.policy_digest, result.dedup_key]) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps an owner-instruction pointer provisional", () => {
    const result = classify(explicitMemoryInput());
    expect(result).toMatchObject({
      input_class: "explicit_user_instruction",
      confidence: "confirmed",
      state: "rejected",
      classification_reason: "OWNER_PROVENANCE_INVALID",
      source: { principal_id: "principal:owner", authenticated_session_digest: null },
    });
    expect(result.source_refs).toEqual([]);
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
          references: [evidenceRef("existing_memory", "memory-existing")],
        },
      }),
    ];

    // When: each candidate is classified.
    const results = values.map(value => classify(value));

    // Then: authority-dependent classes remain rejected; the closed inference alone reaches the confirmation gate.
    expect(results.map(result => result.state)).toEqual(["rejected", "awaiting_confirmation", "rejected", "rejected"]);
    expect(results.every(result => result.required_confirmation)).toBe(true);
    expect(results.every(result => result.confirmation_gate === MEMORY_CANDIDATE_CONFIRMATION_GATE)).toBe(true);
    expect(results[0]).toMatchObject({ policy_sensitivity: "sensitive", storage_sensitivity: "sensitive" });
    expect(results[1]).toMatchObject({ confidence: "inferred", storage_sensitivity: "normal" });
    expect(results[3]).toMatchObject({ conflict_state: "supersede", classification_reason: "UNVERIFIED_OUTCOME" });
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
        request_id: "decision-request-task27",
        receipt_id: "decision-receipt-task27",
        command_digest: null,
      },
    });
    expect(Object.keys(result)).not.toContain("receipt");
  });

  it("does not let no-data mask missing outcome authority", () => {
    const result = classify(verifiedMemoryInput({
      second_brain: { state: "no_data", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T12:01:00.000Z" },
    }));
    expect(result).toMatchObject({
      state: "rejected",
      classification_reason: "UNVERIFIED_OUTCOME",
      delivery: { state: "blocked", reason: "UNVERIFIED_OUTCOME" },
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
      expect(classifyMemoryCandidate(policy, inferredMemoryInput(), new Date(now)).state)
        .toBe(state === "approved" ? "awaiting_confirmation" : state);
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
      evidenceRef("inference_evidence", "inference-evidence-first"),
      evidenceRef("inference_evidence", "inference-evidence-second"),
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
