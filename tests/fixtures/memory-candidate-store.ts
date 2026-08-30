import { sign } from "node:crypto";
import { dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorityDb,
  ControlPlane,
  MemoryCandidateStore,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
} from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import {
  MEMORY_VERIFICATION_AUTHORITY_DOMAIN,
  type MemoryVerificationAuthorityPayload,
} from "../../src/memory-candidate-authority-verification.js";
import { parseMemoryCandidateInput } from "../../src/memory-candidate-input.js";
import { memoryCandidateIdentity } from "../../src/memory-candidate-material.js";
import { base64url } from "../../src/receipt.js";
import { bindExternal, externalAnchors, localKey, verifierKey } from "../helpers.js";
import {
  memoryHash,
  memoryPolicy,
  MEMORY_AUTHORITY_EXPIRES,
  MEMORY_AUTHORITY_ISSUED,
  MEMORY_NOW,
} from "./memory-candidate-fixture.js";

export type MemoryDatabase = { readonly authority: AuthorityDb; readonly root: string; readonly path: string; readonly anchorsRoot: string };
export function memoryRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record required");
  return value as Record<string, unknown>;
}

export async function memoryDatabase(): Promise<MemoryDatabase> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-task27-memory-"));
  const path = join(root, "authority.sqlite");
  const anchors = externalAnchors();
  const authority = new AuthorityDb(path);
  try {
    await authority.initialize({
      decision: { keyId: "decision-test", principal: "principal:owner", publicKeyPath: anchors.decisionPublic },
      verifier: { keyId: "verifier-test", principal: "verifier-independent", publicKeyPath: anchors.verifierPublic },
    });
    bindExternal(authority, anchors);
    return { authority, root, path, anchorsRoot: dirname(anchors.decisionPublic) };
  } catch (error) {
    authority.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(anchors.decisionPublic), { recursive: true, force: true });
    throw error;
  }
}

export function closeMemoryDatabase(value: MemoryDatabase): void {
  value.authority.close();
  rmSync(value.root, { recursive: true, force: true });
  rmSync(value.anchorsRoot, { recursive: true, force: true });
}

export function memoryTableCount(authority: AuthorityDb, table: string): number {
  const value = memoryRecord(authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())["count"];
  if (typeof value !== "number") throw new TypeError("count required");
  return value;
}

export function memoryTableCounts(authority: AuthorityDb): Readonly<Record<string, number>> {
  const rows: readonly unknown[] = authority.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  return Object.fromEntries(rows.map(value => {
    const name = memoryRecord(value)["name"];
    if (typeof name !== "string") throw new TypeError("table name required");
    return [name, memoryTableCount(authority, name)];
  }));
}

export function memoryTableDelta(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>, table: string): number {
  return (after[table] ?? 0) - (before[table] ?? 0);
}

export function memoryCandidateStore(authority: AuthorityDb, policy: unknown = memoryPolicy()): MemoryCandidateStore {
  return new MemoryCandidateStore(authority, policy, () => new Date(MEMORY_NOW));
}

export function memoryPolicyWithRetention(days: number): unknown {
  const policy = structuredClone(memoryPolicy());
  const classes = memoryRecord(memoryRecord(policy)["data_classes"]);
  memoryRecord(classes["memory"])["retention_days"] = days;
  return policy;
}

export function memorySource(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return memoryRecord(value["source"]);
}

function controlBinding(value: Readonly<Record<string, unknown>>, identityKey: "instruction_id" | "decision_id") {
  const input = parseMemoryCandidateInput(value);
  const identity = memoryCandidateIdentity(input);
  return {
    input,
    identity,
    args: {
      schema_version: 1,
      candidate_id: identity.candidate_id,
      correlation_id: identity.correlation_id,
      subject_digest: identity.subject_digest,
      content_digest: identity.content_digest,
      source_id: input.source.source_id,
      source_version: input.source.source_version,
      operation: input.operation,
      purpose: input.purpose,
      sensitivity: input.sensitivity,
      [identityKey]: `${identityKey === "instruction_id" ? "instruction" : "decision"}-${identity.candidate_id.slice(-16)}`,
    },
  };
}

function seedControl(authority: AuthorityDb, value: Readonly<Record<string, unknown>>, kind: "instruction" | "decision"): void {
  const binding = controlBinding(value, kind === "instruction" ? "instruction_id" : "decision_id");
  const requestId = binding.input.source.request_id;
  const receiptId = binding.input.source.receipt_id;
  if (requestId === null || receiptId === null) throw new TypeError("control authority pointer required");
  const request: ControlCommandRequestInput = {
    schema_version: 1,
    request_id: requestId,
    action: kind === "instruction" ? "memory.instruction.record" : "memory.decision.record",
    action_level: 3,
    target: { candidate_id: binding.identity.candidate_id, correlation_id: binding.identity.correlation_id },
    args: binding.args,
    reversible: false,
    requested_by: binding.input.principal_id,
    requested_at: MEMORY_AUTHORITY_ISSUED,
    expires_at: MEMORY_AUTHORITY_EXPIRES,
    nonce: `${kind}-request-nonce-${binding.identity.candidate_id.slice(-12)}`,
  };
  const control = new ControlPlane(authority);
  const staged = control.stage(request, new Date(MEMORY_NOW));
  const receipt: Omit<CommandApprovalReceipt, "signature"> = {
    schema_version: 1,
    receipt_id: receiptId,
    request_id: requestId,
    decision: "approve",
    command_digest: staged.command_digest,
    signer_principal_id: binding.input.principal_id,
    authenticated_session_id: `owner-session-${binding.identity.candidate_id.slice(-12)}`,
    key_id: "decision-test",
    algorithm: "Ed25519",
    issued_at: MEMORY_AUTHORITY_ISSUED,
    not_before: MEMORY_AUTHORITY_ISSUED,
    expires_at: MEMORY_AUTHORITY_EXPIRES,
    nonce: `${kind}-receipt-nonce-${binding.identity.candidate_id.slice(-12)}`,
    max_uses: 1,
    status: "issued",
  };
  control.decide(signCommandApproval(receipt, localKey(authority)), new Date(MEMORY_NOW));
}

export function seedMemoryInstruction(authority: AuthorityDb, input: Readonly<Record<string, unknown>>): void {
  seedControl(authority, input, "instruction");
}

export function seedMemoryDecision(authority: AuthorityDb, input: Readonly<Record<string, unknown>>): void {
  seedControl(authority, input, "decision");
}

export function memoryVerificationPayload(
  value: Readonly<Record<string, unknown>>,
  overrides: Partial<MemoryVerificationAuthorityPayload> = {},
): MemoryVerificationAuthorityPayload {
  const input = parseMemoryCandidateInput(value);
  const identity = memoryCandidateIdentity(input);
  const evidenceId = input.source.evidence_id;
  if (evidenceId === null) throw new TypeError("verification authority pointer required");
  const suffix = identity.candidate_id.slice(-16);
  return {
    schema_version: 1,
    evidence_id: evidenceId,
    candidate_id: identity.candidate_id,
    correlation_id: identity.correlation_id,
    principal_id: input.principal_id,
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    subject_digest: identity.subject_digest,
    content_digest: identity.content_digest,
    operation: input.operation,
    purpose: "personal_memory",
    sensitivity: input.sensitivity,
    outcome_id: `outcome-${suffix}`,
    outcome: "succeeded",
    attempt_id: `attempt-${suffix}`,
    worker_id: `worker-${suffix}`,
    worker_session_id: `worker-session-${suffix}`,
    verifier_id: "verifier-independent",
    verifier_key_id: "verifier-test",
    artifact_id: `artifact-${suffix}`,
    evidence_digest: memoryHash("fixture/machine-evidence/v1\0", { candidate_id: identity.candidate_id, attempt_id: `attempt-${suffix}` }),
    issued_at: MEMORY_AUTHORITY_ISSUED,
    not_before: MEMORY_AUTHORITY_ISSUED,
    expires_at: MEMORY_AUTHORITY_EXPIRES,
    nonce: `verification-nonce-${suffix}`,
    max_uses: 1,
    status: "issued",
    ...overrides,
  };
}

export type MemoryVerificationAuthorityInsert = Omit<
  MemoryVerificationAuthorityPayload,
  "outcome" | "max_uses" | "status"
> & { readonly outcome: string; readonly max_uses: number; readonly status: string };

export function insertMemoryVerification(
  authority: AuthorityDb,
  payload: MemoryVerificationAuthorityInsert,
  signedPayload: MemoryVerificationAuthorityInsert = payload,
): void {
  const signature = base64url(sign(null, Buffer.from(MEMORY_VERIFICATION_AUTHORITY_DOMAIN + canonicalize(signedPayload)), verifierKey(authority)));
  authority.db.prepare(
    `INSERT INTO memory_candidate_verification_authority(
      evidence_id,schema_version,candidate_id,correlation_id,principal_id,source_id,source_version,subject_digest,content_digest,
      operation,purpose,sensitivity,outcome_id,outcome,attempt_id,worker_id,worker_session_id,verifier_id,verifier_key_id,
      artifact_id,evidence_digest,issued_at,not_before,expires_at,nonce,max_uses,status,signer_key_id,payload_json,signature,created_at
     ) VALUES(${Array.from({ length: 31 }, () => "?").join(",")})`,
  ).run(
    payload.evidence_id, payload.schema_version, payload.candidate_id, payload.correlation_id, payload.principal_id,
    payload.source_id, payload.source_version, payload.subject_digest, payload.content_digest, payload.operation,
    payload.purpose, payload.sensitivity, payload.outcome_id, payload.outcome, payload.attempt_id, payload.worker_id,
    payload.worker_session_id, payload.verifier_id, payload.verifier_key_id, payload.artifact_id, payload.evidence_digest,
    payload.issued_at, payload.not_before, payload.expires_at, payload.nonce, payload.max_uses, payload.status,
    payload.verifier_key_id, canonicalize(payload), signature, payload.issued_at,
  );
}

export function seedMemoryVerification(authority: AuthorityDb, value: Readonly<Record<string, unknown>>): void {
  insertMemoryVerification(authority, memoryVerificationPayload(value));
}

export function seedMemoryAuthority(authority: AuthorityDb, input: Readonly<Record<string, unknown>>): void {
  const source = memorySource(input);
  if (source["class"] === "verified_outcome") seedMemoryVerification(authority, input);
  else if (source["class"] === "explicit_user_instruction") seedMemoryInstruction(authority, input);
  else if (source["class"] === "approved_decision") seedMemoryDecision(authority, input);
}
