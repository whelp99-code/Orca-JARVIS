import { describe, expect, it } from "vitest";
import {
  parseCreateTaskRequest,
  parseReceiptDecision,
  type CreateTaskRequest,
} from "../../src/dashboard/validation.js";

const sha256 = "a".repeat(64);
const deadline = "2026-08-10T06:00:00.000Z";

const validRequest = {
  schema_version: 1,
  request_id: "req-1",
  nonce: "nonce-1",
  task_id: "task-1",
  run_id: "run-1",
  expected_proposal_digest: `sha256:${sha256}`,
  proposal_request: {
    schema_version: 1,
    objective: "wire argo cli to jaw",
    work_type: "development",
    completion_evidence: ["passing focused vitest"],
    answers: [{ question_id: "work_type", answer: "development" }],
    constraints: ["no persistence"],
    requested_capabilities: ["codex"],
  },
  budget: { max_steps: 10, max_attempts_per_node: 3, deadline },
} as const;

describe("dashboard CreateTaskRequest validation", () => {
  it("accepts a fully valid CreateTaskRequest with every field", () => {
    const request = parseCreateTaskRequest(validRequest);
    expect(request).toEqual({ ...validRequest, proposal_request: { ...validRequest.proposal_request } });
    expect(request.schema_version).toBe(1);
    expect(request.expected_proposal_digest).toBe(`sha256:${sha256}`);
  });

  it("rejects non-record inputs and missing required fields", () => {
    for (const value of [null, undefined, [], "task", 42, {}]) {
      expect(() => parseCreateTaskRequest(value)).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    }
    const omit = (key: keyof typeof validRequest) => {
      const rest = { ...validRequest };
      delete rest[key];
      return rest;
    };
    for (const key of ["schema_version", "request_id", "nonce", "task_id", "run_id", "expected_proposal_digest", "proposal_request", "budget"] as const) {
      expect(() => parseCreateTaskRequest(omit(key))).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    }
  });

  it("rejects unknown keys at the envelope, proposal, and budget level", () => {
    for (const extra of [
      { token: "secret" },
      { proposal_request: { ...validRequest.proposal_request, extra: true } },
      { budget: { ...validRequest.budget, extra: true } },
      { arbitrary: 1 },
    ]) {
      expect(() => parseCreateTaskRequest({ ...validRequest, ...extra })).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    }
  });

  it("rejects malformed identifiers and digests", () => {
    const invalid = (value: unknown) => expect(() => parseCreateTaskRequest(value)).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    invalid({ ...validRequest, schema_version: "1" });
    invalid({ ...validRequest, request_id: "   " });
    invalid({ ...validRequest, request_id: "x".repeat(129) });
    invalid({ ...validRequest, nonce: "x".repeat(129) });
    invalid({ ...validRequest, task_id: "x".repeat(129) });
    invalid({ ...validRequest, run_id: "x".repeat(129) });
    invalid({ ...validRequest, expected_proposal_digest: "abc123" });
    invalid({ ...validRequest, expected_proposal_digest: `sha256:${"A".repeat(64)}` });
    invalid({ ...validRequest, expected_proposal_digest: `sha1:${sha256}` });
    invalid({ ...validRequest, expected_proposal_digest: `sha256:${"a".repeat(63)}` });
  });

  it("rejects malformed proposal_request payloads", () => {
    const invalid = (value: unknown) => expect(() => parseCreateTaskRequest(value)).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    invalid({ ...validRequest, proposal_request: null });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, schema_version: 2 } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, objective: "   " } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, objective: "x".repeat(4097) } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, work_type: "operations" } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, requested_capabilities: ["terraform"] } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, completion_evidence: ["x".repeat(513)] } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, answers: [{ question_id: "work_type", answer: "x".repeat(513) }] } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, answers: [{ question_id: "nonexistent", answer: "x" }] } });
    invalid({ ...validRequest, proposal_request: { ...validRequest.proposal_request, constraints: ["x".repeat(513)] } });
  });

  it("rejects malformed budget values", () => {
    const invalid = (value: unknown) => expect(() => parseCreateTaskRequest(value)).toThrow(expect.objectContaining({ code: "TASK_INPUT_INVALID" }));
    invalid({ ...validRequest, budget: null });
    invalid({ ...validRequest, budget: {} });
    invalid({ ...validRequest, budget: { max_steps: 0 } });
    invalid({ ...validRequest, budget: { max_steps: 101 } });
    invalid({ ...validRequest, budget: { max_steps: 10.5 } });
    invalid({ ...validRequest, budget: { max_steps: 10, max_attempts_per_node: 0 } });
    invalid({ ...validRequest, budget: { max_steps: 10, max_attempts_per_node: 11 } });
    invalid({ ...validRequest, budget: { max_steps: 10, max_attempts_per_node: 2.5 } });
    invalid({ ...validRequest, budget: { max_steps: 10, max_attempts_per_node: 3, deadline: "2026-08-10T06:00:00Z" } });
    invalid({ ...validRequest, budget: { max_steps: 10, max_attempts_per_node: 3, deadline: "not-a-date" } });
  });

  it("accepts every bounded identifier and string at its maximum length", () => {
    const atLimit: CreateTaskRequest = {
      ...validRequest,
      request_id: "x".repeat(128),
      nonce: "x".repeat(128),
      task_id: "x".repeat(128),
      run_id: "x".repeat(128),
      proposal_request: {
        ...validRequest.proposal_request,
        objective: "x".repeat(4096),
        completion_evidence: ["x".repeat(512)],
        constraints: ["x".repeat(512)],
      },
    };
    const request = parseCreateTaskRequest(atLimit);
    expect(request.request_id).toHaveLength(128);
    expect(request.proposal_request.objective).toHaveLength(4096);
  });

  it("accepts a request with every optional proposal field omitted", () => {
    const minimalProposal = {
      schema_version: validRequest.proposal_request.schema_version,
      objective: validRequest.proposal_request.objective,
    };
    const request = parseCreateTaskRequest({ ...validRequest, proposal_request: minimalProposal });
    expect(request.proposal_request.work_type).toBeUndefined();
    expect(request.proposal_request.completion_evidence).toBeUndefined();
  });
});

const receipt = {
  schema_version: 1,
  receipt_id: "receipt-1",
  request_id: "req-1",
  decision: "approve",
  command_digest: `sha256:${"b".repeat(64)}`,
  signer_principal_id: "operator",
  authenticated_session_id: "session-1",
  key_id: "key-1",
  algorithm: "Ed25519",
  issued_at: "2026-08-09T06:00:00.000Z",
  not_before: "2026-08-09T06:00:00.000Z",
  expires_at: "2026-08-09T06:10:00.000Z",
  nonce: "nonce-1",
  max_uses: 1,
  status: "issued",
  signature: "b".repeat(86),
} as const;

describe("dashboard receipt decision validation", () => {
  it("accepts an exact receipt decision envelope", () => {
    const decision = parseReceiptDecision({ schema_version: 1, receipt });
    expect(decision).toEqual({ schema_version: 1, receipt: { ...receipt } });
    expect(decision.receipt.decision).toBe("approve");
  });

  it("rejects a missing receipt, wrong schema version, and unknown keys", () => {
    for (const value of [null, {}, { schema_version: 1 }, { schema_version: 2, receipt }, { receipt }, { schema_version: 1, receipt, extra: true }]) {
      expect(() => parseReceiptDecision(value)).toThrow(expect.objectContaining({ code: "RECEIPT_DECISION_INVALID" }));
    }
  });

  it("rejects malformed receipts without inventing normalization", () => {
    const invalid = (value: unknown) => expect(() => parseReceiptDecision(value)).toThrow(expect.objectContaining({ code: "RECEIPT_DECISION_INVALID" }));
    invalid({ schema_version: 1, receipt: { ...receipt, schema_version: 2 } });
    invalid({ schema_version: 1, receipt: { ...receipt, decision: "escalate" } });
    invalid({ schema_version: 1, receipt: { ...receipt, algorithm: "RSA" } });
    invalid({ schema_version: 1, receipt: { ...receipt, status: "revoked" } });
    invalid({ schema_version: 1, receipt: { ...receipt, max_uses: 2 } });
    invalid({ schema_version: 1, receipt: { ...receipt, signature: "" } });
    invalid({ schema_version: 1, receipt: { ...receipt, expires_at: "2026-08-09T06:00:00Z" } });
  });
});
