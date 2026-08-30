import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../../src/canonical.js";

export const MEMORY_NOW = "2026-08-28T12:00:00.000Z";
export const MEMORY_OBSERVED = "2026-08-28T11:00:00.000Z";
export const MEMORY_FRESH_UNTIL = "2026-08-28T13:00:00.000Z";
export const MEMORY_SOURCE_EXPIRES = "2026-08-29T12:00:00.000Z";
export const MEMORY_AUTHORITY_ISSUED = "2026-08-28T11:55:00.000Z";
export const MEMORY_AUTHORITY_EXPIRES = "2026-08-28T12:05:00.000Z";
export const MEMORY_DOMAINS = {
  content: "orca-jarvis/memory-content/v1\0",
  subject: "orca-jarvis/memory-subject/v1\0",
  verification: "orca-jarvis/memory-verification/v1\0",
} as const;

export function memoryHash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}

export function memoryPolicy(): unknown {
  const value: unknown = JSON.parse(readFileSync(join(process.cwd(), "config/personal-os-policy.json"), "utf8"));
  return value;
}

type EvidenceRefOptions = {
  readonly namespace?: string;
  readonly evidence_digest?: string;
  readonly observed_at?: string;
  readonly fresh_until?: string;
  readonly expires_at?: string;
};
const defaultNamespace: Readonly<Record<string, string>> = {
  verification: "verification_authority",
  artifact: "verification_artifact",
  owner_instruction: "control_command",
  owner_session: "control_receipt",
  inference_evidence: "inference_evidence",
  existing_memory: "memory_candidate",
  second_brain_conflict: "second_brain_conflict",
  transcript: "rejected_input",
  unverified: "rejected_input",
};
export function evidenceRef(kind: string, id: string, options: EvidenceRefOptions = {}): Record<string, unknown> {
  return {
    kind,
    identifier: {
      namespace: options.namespace ?? defaultNamespace[kind],
      id: memoryHash("fixture/reference-id/v1\0", { kind, id }).slice(7),
      version: 1,
    },
    evidence_digest: options.evidence_digest ?? memoryHash("fixture/evidence/v1\0", id),
    observed_at: options.observed_at ?? MEMORY_OBSERVED,
    fresh_until: options.fresh_until ?? MEMORY_FRESH_UNTIL,
    expires_at: options.expires_at ?? MEMORY_SOURCE_EXPIRES,
  };
}

type CandidateOptions = {
  readonly idempotency_key?: string;
  readonly authority_id?: string;
  readonly operation?: "remember" | "correct";
  readonly subject?: string;
  readonly statement?: string;
  readonly purpose?: string;
  readonly sensitivity?: "public" | "personal" | "sensitive" | "restricted";
  readonly host?: "linux-control-plane" | "linux-second-brain";
  readonly principal_id?: string;
  readonly payload_fields?: readonly string[];
  readonly source?: Record<string, unknown>;
  readonly second_brain?: Record<string, unknown>;
  readonly conflict?: Record<string, unknown>;
};

function candidate(source: Record<string, unknown>, options: CandidateOptions): Record<string, unknown> {
  return {
    schema_version: 1,
    idempotency_key: options.idempotency_key ?? "candidate:task27:verified",
    operation: options.operation ?? "remember",
    subject: options.subject ?? "Task 27 verification",
    statement: options.statement ?? "Task 27 passed independent technical verification.",
    purpose: options.purpose ?? "personal_memory",
    sensitivity: options.sensitivity ?? "personal",
    host: options.host ?? "linux-second-brain",
    principal_id: options.principal_id ?? "principal:owner",
    payload_fields: options.payload_fields ?? ["summary"],
    source: options.source ?? source,
    second_brain: options.second_brain ?? { state: "available" },
    conflict: options.conflict ?? { state: "none", references: [] },
  };
}

export function verifiedMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const authority = options.authority_id ?? "task27";
  return candidate({
    class: "verified_outcome",
    source_id: `verified-source-${authority}`,
    source_version: "v1",
    evidence_id: `verification-${authority}`,
  }, options);
}

export function explicitMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const authority = options.authority_id ?? "task27";
  const statement = options.statement ?? "Remember that I prefer bounded technical summaries.";
  return candidate({
    class: "explicit_user_instruction",
    source_id: `instruction-source-${authority}`,
    source_version: "v1",
    request_id: `instruction-request-${authority}`,
    receipt_id: `instruction-receipt-${authority}`,
  }, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:instruction",
    statement,
  });
}

export function inferredMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const authority = options.authority_id ?? "task27";
  return candidate({
    class: "labeled_inference",
    source_id: `inference-source-${authority}`,
    source_version: "v1",
    inference_id: `inference-${authority}`,
    label: "inference",
    references: [evidenceRef("inference_evidence", `inference-evidence-${authority}`)],
  }, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:inference",
    subject: options.subject ?? "Owner summary preference",
    statement: options.statement ?? "The owner may prefer concise technical summaries.",
  });
}

export function approvedDecisionMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const authority = options.authority_id ?? "task27";
  return candidate({
    class: "approved_decision",
    source_id: `decision-source-${authority}`,
    source_version: "v1",
    request_id: `decision-request-${authority}`,
    receipt_id: `decision-receipt-${authority}`,
  }, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:decision",
    subject: options.subject ?? "Approved control-plane decision",
    statement: options.statement ?? "Proceed with the approved bounded memory policy decision.",
  });
}

export const REJECTED_SOURCE_CLASSES = [
  "raw_transcript", "worker_assertion", "unverified_summary", "transient_runtime", "unlabeled_trait_inference",
  "model_assertion",
] as const;

export function rejectedMemoryInput(
  sourceClass: (typeof REJECTED_SOURCE_CLASSES)[number],
  options: CandidateOptions = {},
): Record<string, unknown> {
  const authority = options.authority_id ?? sourceClass.replaceAll("_", "-");
  const source = {
    class: sourceClass,
    source_id: `rejected-source-${authority}`,
    source_version: "v1",
    references: [evidenceRef(sourceClass === "raw_transcript" ? "transcript" : "unverified", `rejected-${authority}`)],
  };
  return candidate(source, { ...options, idempotency_key: options.idempotency_key ?? `candidate:task27:${sourceClass}` });
}
