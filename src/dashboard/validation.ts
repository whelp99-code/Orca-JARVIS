import type { CapabilityFact } from "../capabilities.js";
import type { CommandApprovalReceipt } from "../control-plane.js";
import { JarvisError } from "../db.js";
import type { TeamProposalRequestV1, TeamWorkType } from "../team-proposal.js";
import {
  ANSWER_KEYS,
  BUDGET_KEYS,
  CAPABILITY_IDS,
  CREATE_TASK_KEYS,
  DASHBOARD_SCHEMA_VERSION,
  DIGEST_PATTERN,
  FIELD_LIMIT,
  ID_LIMIT,
  LIST_LIMIT,
  MAX_ATTEMPTS_MAX,
  MAX_ATTEMPTS_MIN,
  MAX_STEPS_MAX,
  MAX_STEPS_MIN,
  OBJECTIVE_LIMIT,
  PROPOSAL_KEYS,
  QUESTION_ID_LIMIT,
  QUESTION_IDS,
  RECEIPT_ALGORITHM,
  RECEIPT_DECISION_INVALID,
  RECEIPT_DECISION_KEYS,
  RECEIPT_DECISIONS,
  RECEIPT_KEYS,
  RECEIPT_MAX_USES,
  RECEIPT_STATUS,
  RFC3339_MS_PATTERN,
  SIGNATURE_LIMIT,
  TASK_INPUT_INVALID,
  WORK_TYPES,
  type CreateTaskRequest,
  type ReceiptDecision,
  type ReceiptDecisionRequest,
  type Sha256Digest,
  type TaskBudget,
} from "./contracts.js";

export type { CreateTaskRequest, ReceiptDecisionRequest } from "./contracts.js";

type Fail = () => never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failWith(code: string): Fail {
  return () => {
    throw new JarvisError(code);
  };
}

function record(value: unknown, fail: Fail): Record<string, unknown> {
  if (!isRecord(value)) fail();
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], fail: Fail): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function allowKeys(value: Record<string, unknown>, keys: readonly string[], fail: Fail): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
}

function nfcString(value: unknown, max: number, fail: Fail): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0) fail();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > max) fail();
  return value;
}

function parseLiteral<T extends string>(value: unknown, allowed: readonly T[], fail: Fail): T {
  if (typeof value !== "string") fail();
  for (const item of allowed) {
    if (item === value) return item;
  }
  return fail();
}

function parseDigest(value: unknown, fail: Fail): Sha256Digest {
  if (typeof value !== "string") fail();
  const match = DIGEST_PATTERN.exec(value);
  if (match?.[1] === undefined) fail();
  return `sha256:${match[1]}`;
}

function parseTimestamp(value: unknown, fail: Fail): string {
  if (typeof value !== "string" || !RFC3339_MS_PATTERN.test(value)) fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail();
  return value;
}

function boundedInt(value: unknown, range: readonly [number, number], fail: Fail): number {
  const [min, max] = range;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}

function stringList(value: unknown, fail: Fail): readonly string[] {
  if (!Array.isArray(value) || value.length > LIST_LIMIT) fail();
  return value.map((item) => nfcString(item, FIELD_LIMIT, fail));
}

function parseCapabilities(value: unknown, fail: Fail): ReadonlyArray<CapabilityFact["id"]> {
  if (!Array.isArray(value) || value.length > CAPABILITY_IDS.length) fail();
  const seen = new Set<string>();
  return value.map((item) => {
    const id = parseLiteral(item, CAPABILITY_IDS, fail);
    if (seen.has(id)) fail();
    seen.add(id);
    return id;
  });
}

function isQuestionId(value: string): value is (typeof QUESTION_IDS)[number] {
  return QUESTION_IDS.some((id) => id === value);
}

function parseAnswers(value: unknown, fail: Fail): TeamProposalRequestV1["answers"] {
  if (!Array.isArray(value) || value.length > LIST_LIMIT) fail();
  const seen = new Set<string>();
  return value.map((item) => {
    const input = record(item, fail);
    exactKeys(input, ANSWER_KEYS, fail);
    const question_id = nfcString(input.question_id, QUESTION_ID_LIMIT, fail);
    if (!isQuestionId(question_id) || seen.has(question_id)) fail();
    seen.add(question_id);
    return { question_id, answer: nfcString(input.answer, FIELD_LIMIT, fail) };
  });
}

function parseProposal(value: unknown, fail: Fail): TeamProposalRequestV1 {
  const input = record(value, fail);
  allowKeys(input, PROPOSAL_KEYS, fail);
  if (!Object.hasOwn(input, "schema_version") || !Object.hasOwn(input, "objective") || input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  const parsed: TeamProposalRequestV1 = {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    objective: nfcString(input.objective, OBJECTIVE_LIMIT, fail),
  };
  if (Object.hasOwn(input, "work_type")) parsed.work_type = parseLiteral<TeamWorkType>(input.work_type, WORK_TYPES, fail);
  if (Object.hasOwn(input, "completion_evidence")) parsed.completion_evidence = stringList(input.completion_evidence, fail);
  if (Object.hasOwn(input, "answers")) parsed.answers = parseAnswers(input.answers, fail);
  if (Object.hasOwn(input, "constraints")) parsed.constraints = stringList(input.constraints, fail);
  if (Object.hasOwn(input, "requested_capabilities")) parsed.requested_capabilities = parseCapabilities(input.requested_capabilities, fail);
  return parsed;
}

function parseBudget(value: unknown, fail: Fail): TaskBudget {
  const input = record(value, fail);
  exactKeys(input, BUDGET_KEYS, fail);
  return {
    max_steps: boundedInt(input.max_steps, [MAX_STEPS_MIN, MAX_STEPS_MAX], fail),
    max_attempts_per_node: boundedInt(input.max_attempts_per_node, [MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX], fail),
    deadline: parseTimestamp(input.deadline, fail),
  };
}

function parseReceipt(value: unknown, fail: Fail): CommandApprovalReceipt {
  const input = record(value, fail);
  exactKeys(input, RECEIPT_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION || input.algorithm !== RECEIPT_ALGORITHM || input.status !== RECEIPT_STATUS || input.max_uses !== RECEIPT_MAX_USES) fail();
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    receipt_id: nfcString(input.receipt_id, ID_LIMIT, fail),
    request_id: nfcString(input.request_id, ID_LIMIT, fail),
    decision: parseLiteral<ReceiptDecision>(input.decision, RECEIPT_DECISIONS, fail),
    command_digest: parseDigest(input.command_digest, fail),
    signer_principal_id: nfcString(input.signer_principal_id, ID_LIMIT, fail),
    authenticated_session_id: nfcString(input.authenticated_session_id, ID_LIMIT, fail),
    key_id: nfcString(input.key_id, ID_LIMIT, fail),
    algorithm: RECEIPT_ALGORITHM,
    issued_at: parseTimestamp(input.issued_at, fail),
    not_before: parseTimestamp(input.not_before, fail),
    expires_at: parseTimestamp(input.expires_at, fail),
    nonce: nfcString(input.nonce, ID_LIMIT, fail),
    max_uses: RECEIPT_MAX_USES,
    status: RECEIPT_STATUS,
    signature: nfcString(input.signature, SIGNATURE_LIMIT, fail),
  };
}

export function parseCreateTaskRequest(value: unknown): CreateTaskRequest {
  const fail = failWith(TASK_INPUT_INVALID);
  const input = record(value, fail);
  exactKeys(input, CREATE_TASK_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: nfcString(input.request_id, ID_LIMIT, fail),
    nonce: nfcString(input.nonce, ID_LIMIT, fail),
    task_id: nfcString(input.task_id, ID_LIMIT, fail),
    run_id: nfcString(input.run_id, ID_LIMIT, fail),
    expected_proposal_digest: parseDigest(input.expected_proposal_digest, fail),
    proposal_request: parseProposal(input.proposal_request, fail),
    budget: parseBudget(input.budget, fail),
  };
}

export function parseReceiptDecision(value: unknown): ReceiptDecisionRequest {
  const fail = failWith(RECEIPT_DECISION_INVALID);
  const input = record(value, fail);
  exactKeys(input, RECEIPT_DECISION_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  return { schema_version: DASHBOARD_SCHEMA_VERSION, receipt: parseReceipt(input.receipt, fail) };
}
