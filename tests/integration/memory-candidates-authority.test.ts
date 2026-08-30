import { describe, expect, it } from "vitest";
import * as jarvis from "../../src/index.js";
import { MemoryCandidateStore } from "../../src/index.js";
import {
  approvedDecisionMemoryInput,
  explicitMemoryInput,
  memoryPolicy,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  insertMemoryVerification,
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  memorySource,
  memoryTableCount,
  memoryTableCounts,
  memoryVerificationPayload,
  seedMemoryDecision,
  seedMemoryInstruction,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

function withKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  value["idempotency_key"] = `candidate:authority:${key}`;
  return value;
}

function changedHex(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
}

function expectAuthorityFailure(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_AUTHORITY_INVALID" }));
}

describe("Task 27 immutable authority provenance", () => {
  it("binds every candidate identity/content field to signed verifier authority", async () => {
    const database = await memoryDatabase();
    try {
      const baseline = verifiedMemoryInput({ authority_id: "verification-binding" });
      seedMemoryVerification(database.authority, baseline);
      const mutations: Array<readonly [string, (value: Record<string, unknown>) => void]> = [
        ["statement", value => { value["statement"] = "Mutated verified content."; }],
        ["subject", value => { value["subject"] = "Mutated verified subject"; }],
        ["operation", value => { value["operation"] = "correct"; }],
        ["sensitivity", value => { value["sensitivity"] = "sensitive"; }],
        ["purpose", value => { value["purpose"] = "live_awareness"; }],
        ["principal", value => { value["principal_id"] = "principal:foreign"; }],
        ["source-id", value => { memorySource(value)["source_id"] = "verified-source-mutated"; }],
        ["source-version", value => { memorySource(value)["source_version"] = "v2"; }],
        ["evidence-id", value => { memorySource(value)["evidence_id"] = "verification-unknown"; }],
      ];
      const store = memoryCandidateStore(database.authority);
      for (const [key, mutate] of mutations) {
        const value = withKey(structuredClone(baseline), key);
        mutate(value);
        const before = memoryTableCounts(database.authority);
        expectAuthorityFailure(() => store.classify(value));
        expect(memoryTableCounts(database.authority), key).toEqual(before);
      }
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(0);
      const approved = store.classify(baseline);
      expect(approved).toMatchObject({
        state: "approved",
        classification_reason: "VERIFIED_OUTCOME_APPROVED",
        source: {
          verifier_id: "verifier-independent",
          verification_evidence_id: "verification-verification-binding",
          authenticated_session_digest: null,
          outcome_id: expect.stringMatching(/^outcome-[0-9a-f]{16}$/),
          attempt_id: expect.stringMatching(/^attempt-[0-9a-f]{16}$/),
          worker_id: expect.stringMatching(/^worker-[0-9a-f]{16}$/),
          worker_session_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      });
      const authority = memoryRecord(database.authority.db.prepare(
        "SELECT evidence_digest FROM memory_candidate_verification_authority WHERE evidence_id='verification-verification-binding'",
      ).get());
      expect(approved.source_refs[1]?.evidence_digest).toBe(authority["evidence_digest"]);
      const reused = withKey(structuredClone(baseline), "after-claim");
      reused["statement"] = "A claimed verifier record cannot approve changed content.";
      const beforeReuse = memoryTableCounts(database.authority);
      expectAuthorityFailure(() => store.classify(reused));
      expect(memoryTableCounts(database.authority)).toEqual(beforeReuse);
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(1);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("rejects signed-but-mismatched, expired, future, revoked, and signature-mutated verifier records", async () => {
    const database = await memoryDatabase();
    try {
      const cases: Array<readonly [string, (payload: ReturnType<typeof memoryVerificationPayload>) => ReturnType<typeof memoryVerificationPayload>]> = [
        ["candidate", payload => ({ ...payload, candidate_id: changedHex(payload.candidate_id) })],
        ["correlation", payload => ({ ...payload, correlation_id: changedHex(payload.correlation_id) })],
        ["principal", payload => ({ ...payload, principal_id: "principal:foreign" })],
        ["source", payload => ({ ...payload, source_id: "verified-source-foreign" })],
        ["version", payload => ({ ...payload, source_version: "v2" })],
        ["subject", payload => ({ ...payload, subject_digest: `sha256:${"1".repeat(64)}` })],
        ["content", payload => ({ ...payload, content_digest: `sha256:${"2".repeat(64)}` })],
        ["operation", payload => ({ ...payload, operation: "correct" })],
        ["sensitivity", payload => ({ ...payload, sensitivity: "public" })],
        ["verifier", payload => ({ ...payload, verifier_id: "verifier-foreign" })],
        ["expired", payload => ({ ...payload, expires_at: "2026-08-28T11:59:59.999Z" })],
        ["future", payload => ({ ...payload, issued_at: "2026-08-28T12:01:00.000Z", not_before: "2026-08-28T12:01:00.000Z" })],
      ];
      const store = memoryCandidateStore(database.authority);
      for (const [key, mutate] of cases) {
        const input = verifiedMemoryInput({ authority_id: `record-${key}`, idempotency_key: `candidate:record:${key}` });
        insertMemoryVerification(database.authority, mutate(memoryVerificationPayload(input)));
        const before = memoryTableCounts(database.authority);
        expectAuthorityFailure(() => store.classify(input));
        expect(memoryTableCounts(database.authority), key).toEqual(before);
      }
      const signatureInput = verifiedMemoryInput({ authority_id: "signature", idempotency_key: "candidate:record:signature" });
      const signaturePayload = memoryVerificationPayload(signatureInput);
      insertMemoryVerification(database.authority, signaturePayload, {
        ...signaturePayload,
        nonce: `${signaturePayload.nonce}-other`,
      });
      const beforeSignature = memoryTableCounts(database.authority);
      expectAuthorityFailure(() => store.classify(signatureInput));
      expect(memoryTableCounts(database.authority)).toEqual(beforeSignature);
      const revokedInput = verifiedMemoryInput({ authority_id: "revoked", idempotency_key: "candidate:record:revoked" });
      seedMemoryVerification(database.authority, revokedInput);
      database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run("verification-revoked", "test-revocation", "2026-08-28T11:59:00.000Z");
      const beforeRevoked = memoryTableCounts(database.authority);
      expectAuthorityFailure(() => store.classify(revokedInput));
      expect(memoryTableCounts(database.authority)).toEqual(beforeRevoked);
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("requires exact owner-signed ControlPlane bindings for instructions and decisions", async () => {
    const database = await memoryDatabase();
    try {
      const instruction = explicitMemoryInput({ authority_id: "control-binding" });
      seedMemoryInstruction(database.authority, instruction);
      const mutations: Array<readonly [string, (value: Record<string, unknown>) => void]> = [
        ["statement", value => { value["statement"] = "Remember a different bounded preference."; }],
        ["subject", value => { value["subject"] = "Different owner preference"; }],
        ["operation", value => { value["operation"] = "correct"; }],
        ["sensitivity", value => { value["sensitivity"] = "sensitive"; }],
        ["principal", value => { value["principal_id"] = "principal:foreign"; }],
        ["source", value => { memorySource(value)["source_id"] = "instruction-source-foreign"; }],
        ["version", value => { memorySource(value)["source_version"] = "v2"; }],
        ["request", value => { memorySource(value)["request_id"] = "instruction-request-unknown"; }],
        ["receipt", value => { memorySource(value)["receipt_id"] = "instruction-receipt-unknown"; }],
      ];
      const store = memoryCandidateStore(database.authority);
      for (const [key, mutate] of mutations) {
        const value = withKey(structuredClone(instruction), `control-${key}`);
        mutate(value);
        const before = memoryTableCounts(database.authority);
        expectAuthorityFailure(() => store.classify(value));
        expect(memoryTableCounts(database.authority), key).toEqual(before);
      }
      expect(store.classify(instruction)).toMatchObject({
        state: "approved",
        classification_reason: "EXPLICIT_OWNER_INSTRUCTION_APPROVED",
        source: { principal_id: "principal:owner", authority_key_id: "decision-test" },
      });
      const decision = approvedDecisionMemoryInput({ authority_id: "decision-binding" });
      seedMemoryDecision(database.authority, decision);
      expect(store.classify(decision)).toMatchObject({ state: "approved", classification_reason: "APPROVED_DECISION_APPROVED" });
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(2);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("enforces owner and verifier expiry at minus-one, equality, and plus-one milliseconds", async () => {
    const classes = [
      { kind: "verified", input: () => verifiedMemoryInput({ authority_id: "boundary-verified" }), seed: seedMemoryVerification },
      { kind: "instruction", input: () => explicitMemoryInput({ authority_id: "boundary-instruction" }), seed: seedMemoryInstruction },
      { kind: "decision", input: () => approvedDecisionMemoryInput({ authority_id: "boundary-decision" }), seed: seedMemoryDecision },
    ] as const;
    const boundaries = [
      ["2026-08-28T12:04:59.999Z", true],
      ["2026-08-28T12:05:00.000Z", false],
      ["2026-08-28T12:05:00.001Z", false],
    ] as const;
    for (const sourceClass of classes) {
      for (const [now, valid] of boundaries) {
        const database = await memoryDatabase();
        try {
          const input = sourceClass.input();
          sourceClass.seed(database.authority, input);
          const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => new Date(now));
          if (valid) expect(store.classify(input).state, `${sourceClass.kind}:${now}`).toBe("approved");
          else expectAuthorityFailure(() => store.classify(input));
          expect(memoryTableCount(database.authority, "memory_candidates"), `${sourceClass.kind}:${now}`)
            .toBe(valid ? 1 : 0);
        } finally {
          closeMemoryDatabase(database);
        }
      }
    }
  });

  it("fails closed at authority expiry and revocation, and seals immutable records", async () => {
    const database = await memoryDatabase();
    try {
      const expired = explicitMemoryInput({ authority_id: "expiry" });
      seedMemoryInstruction(database.authority, expired);
      const late = new MemoryCandidateStore(database.authority, memoryPolicy(), () => new Date("2026-08-28T12:05:00.000Z"));
      const beforeExpired = memoryTableCounts(database.authority);
      expectAuthorityFailure(() => late.classify(expired));
      expect(memoryTableCounts(database.authority)).toEqual(beforeExpired);

      const revoked = approvedDecisionMemoryInput({ authority_id: "revoked-control" });
      seedMemoryDecision(database.authority, revoked);
      database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run("decision-request-revoked-control", "test-revocation", "2026-08-28T11:59:00.000Z");
      const beforeRevoked = memoryTableCounts(database.authority);
      expectAuthorityFailure(() => memoryCandidateStore(database.authority).classify(revoked));
      expect(memoryTableCounts(database.authority)).toEqual(beforeRevoked);

      const evidence = verifiedMemoryInput({ authority_id: "immutable" });
      seedMemoryVerification(database.authority, evidence);
      const immutableFields = [
        "evidence_id", "schema_version", "candidate_id", "correlation_id", "principal_id", "source_id", "source_version",
        "subject_digest", "content_digest", "operation", "purpose", "sensitivity", "outcome_id", "outcome", "attempt_id",
        "worker_id", "worker_session_id", "verifier_id", "verifier_key_id", "artifact_id", "evidence_digest", "issued_at",
        "not_before", "expires_at", "nonce", "max_uses", "status", "signer_key_id", "payload_json", "signature", "created_at",
      ];
      for (const field of immutableFields) expect(() => database.authority.db.prepare(
        `UPDATE memory_candidate_verification_authority SET ${field}=${field} WHERE evidence_id='verification-immutable'`,
      ).run(), field).toThrow("immutable memory verification authority");
      expect(() => database.authority.db.prepare(
        "DELETE FROM memory_candidate_verification_authority WHERE evidence_id='verification-immutable'",
      ).run()).toThrow("immutable memory verification authority");
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("enforces closed outcome, single-use, status, session separation, and validity policy in SQLite", async () => {
    const database = await memoryDatabase();
    try {
      const invalid = [
        ["max-uses", { max_uses: 2 }],
        ["status", { status: "revoked" }],
        ["outcome", { outcome: "failed" }],
        ["same-actor", { worker_id: "verifier-independent" }],
        ["validity", { not_before: "2026-08-28T12:06:00.000Z" }],
      ] as const;
      for (const [key, overrides] of invalid) {
        const input = verifiedMemoryInput({ authority_id: `schema-${key}` });
        const payload = { ...memoryVerificationPayload(input), ...overrides };
        expect(() => insertMemoryVerification(database.authority, payload), key).toThrow();
      }
      expect(memoryTableCount(database.authority, "memory_candidate_verification_authority")).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("adds no public registration surface for evidence, keys, identities, or sessions", async () => {
    const forbidden = [
      "registerMemoryOutcome", "registerMemoryVerification", "registerMemoryAuthorityKey", "registerMemoryVerifier",
      "registerMemoryWorker", "registerOwnerSession", "approveMemoryCandidateAuthority",
    ];
    for (const name of forbidden) expect((jarvis as Record<string, unknown>)[name], name).toBeUndefined();
    const database = await memoryDatabase();
    try {
      for (const name of forbidden) expect(name in database.authority, name).toBe(false);
      const input = verifiedMemoryInput({ authority_id: "cross-purpose" });
      const payload = memoryVerificationPayload(input, { verifier_key_id: "decision-test" });
      expect(() => insertMemoryVerification(database.authority, payload)).toThrow("memory verification authority key required");
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
