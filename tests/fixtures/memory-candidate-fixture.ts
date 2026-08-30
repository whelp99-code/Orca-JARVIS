import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../../src/canonical.js";

export const MEMORY_NOW = "2026-08-28T12:00:00.000Z";
export const MEMORY_OBSERVED = "2026-08-28T11:00:00.000Z";
export const MEMORY_FRESH_UNTIL = "2026-08-28T13:00:00.000Z";
export const MEMORY_SOURCE_EXPIRES = "2026-08-29T12:00:00.000Z";
export const MEMORY_DOMAINS = {
  content: "orca-jarvis/memory-content/v1\0",
  subject: "orca-jarvis/memory-subject/v1\0",
  instruction: "orca-jarvis/memory-owner-instruction/v1\0",
  verification: "orca-jarvis/memory-verification/v1\0",
  decision: "orca-jarvis/memory-decision-binding/v1\0",
} as const;

export function memoryHash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}

export function memoryPolicy(): unknown {
  const value: unknown = JSON.parse(readFileSync(join(process.cwd(), "config/personal-os-policy.json"), "utf8"));
  return value;
}

type EvidenceRefOptions = {
  readonly evidence_digest?: string;
  readonly observed_at?: string;
  readonly fresh_until?: string;
  readonly expires_at?: string;
};
export function evidenceRef(
  kind: string,
  sourceRef: string,
  options: EvidenceRefOptions = {},
): Record<string, unknown> {
  return {
    kind,
    source_ref: sourceRef,
    evidence_digest: options.evidence_digest ?? memoryHash("fixture/evidence/v1\0", sourceRef),
    observed_at: options.observed_at ?? MEMORY_OBSERVED,
    fresh_until: options.fresh_until ?? MEMORY_FRESH_UNTIL,
    expires_at: options.expires_at ?? MEMORY_SOURCE_EXPIRES,
  };
}

type CandidateOptions = {
  readonly idempotency_key?: string;
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
  const statement = options.statement ?? "Task 27 passed independent technical verification.";
  const artifact = evidenceRef("artifact", "artifact:task27");
  const verificationDigest = memoryHash(MEMORY_DOMAINS.verification, {
    outcome_id: "outcome:task27",
    worker_id: "worker:task27",
    verifier_id: "verifier:independent",
    verdict: "passed",
    machine_outcome: "succeeded",
    content_digest: memoryHash(MEMORY_DOMAINS.content, statement),
    artifact,
  });
  const source = {
    class: "verified_outcome",
    source_id: "src:closeout:task27",
    source_version: "v1",
    outcome_id: "outcome:task27",
    worker_id: "worker:task27",
    verifier_id: "verifier:independent",
    verdict: "passed",
    machine_outcome: "succeeded",
    references: [evidenceRef("verification", "verification:task27", { evidence_digest: verificationDigest }), artifact],
  };
  return candidate(source, options);
}

export function explicitMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const statement = options.statement ?? "Remember that I prefer bounded technical summaries.";
  const session = evidenceRef("owner_session", "session-evidence:owner");
  const instructionDigest = memoryHash(MEMORY_DOMAINS.instruction, {
    instruction_id: "instruction:task27",
    principal_id: "principal:owner",
    authenticated_session_id: "session:owner:task27",
    statement,
    session_evidence: session,
  });
  const source = {
    class: "explicit_user_instruction",
    source_id: "src:owner:instruction",
    source_version: "v1",
    instruction_id: "instruction:task27",
    principal_id: "principal:owner",
    authenticated_session_id: "session:owner:task27",
    references: [evidenceRef("owner_instruction", "instruction-evidence:task27", { evidence_digest: instructionDigest }), session],
  };
  return candidate(source, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:instruction",
    statement,
  });
}

export function inferredMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const source = {
    class: "labeled_inference",
    source_id: "src:inference:task27",
    source_version: "v1",
    inference_id: "inference:task27",
    label: "inference",
    references: [evidenceRef("inference_evidence", "inference-evidence:task27")],
  };
  return candidate(source, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:inference",
    subject: options.subject ?? "Owner summary preference",
    statement: options.statement ?? "The owner may prefer concise technical summaries.",
  });
}

export function approvedDecisionMemoryInput(options: CandidateOptions = {}): Record<string, unknown> {
  const source = {
    class: "approved_decision",
    source_id: "src:control-plane:decision",
    source_version: "v1",
    request_id: "request:task27:decision",
    receipt_id: "receipt:task27:decision",
    command_digest: `sha256:${"a".repeat(64)}`,
    signer_principal_id: "principal:owner",
    authenticated_session_id: "session:owner:task27",
    issued_at: MEMORY_OBSERVED,
    expires_at: MEMORY_SOURCE_EXPIRES,
  };
  return candidate(source, {
    ...options,
    idempotency_key: options.idempotency_key ?? "candidate:task27:decision",
    subject: options.subject ?? "Approved control-plane decision",
    statement: options.statement ?? "Proceed with the approved bounded memory policy decision.",
  });
}

export const REJECTED_SOURCE_CLASSES = [
  "raw_transcript",
  "worker_assertion",
  "unverified_summary",
  "transient_runtime",
  "unlabeled_trait_inference",
  "model_assertion",
] as const;

export function rejectedMemoryInput(
  sourceClass: (typeof REJECTED_SOURCE_CLASSES)[number],
  options: CandidateOptions = {},
): Record<string, unknown> {
  const source = {
    class: sourceClass,
    source_id: `src:rejected:${sourceClass}`,
    source_version: "v1",
    references: [evidenceRef(sourceClass === "raw_transcript" ? "transcript" : "unverified", `rejected:${sourceClass}`)],
  };
  return candidate(source, {
    ...options,
    idempotency_key: options.idempotency_key ?? `candidate:task27:${sourceClass}`,
  });
}

function requiredText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("memory fixture text required");
  return value;
}

export function decisionBindingDigest(value: Readonly<Record<string, unknown>>): string {
  return memoryHash(MEMORY_DOMAINS.decision, {
    content_digest: memoryHash(MEMORY_DOMAINS.content, requiredText(value["statement"])),
    subject_digest: memoryHash(MEMORY_DOMAINS.subject, requiredText(value["subject"])),
    operation: value["operation"],
    purpose: value["purpose"],
    sensitivity: value["sensitivity"],
  });
}
