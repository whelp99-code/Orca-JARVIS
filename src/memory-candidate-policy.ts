import {
  evaluatePersonalOsPolicy,
  parsePersonalOsPolicy,
  PersonalPolicyError,
} from "./personal-os-policy.js";
import {
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateReasonCode,
  type ParsedMemoryCandidateInput,
  type ParsedMemoryReference,
} from "./memory-candidate-types.js";
import {
  cloneMemoryPolicy,
  memoryFail,
  memoryHash,
} from "./memory-candidate-values.js";

const DAY_MS = 86_400_000;
export type ParsedMemoryCandidatePolicy = ReturnType<typeof parsePersonalOsPolicy>;
export type MemoryPolicyOutcome = {
  readonly status: "allow" | "confirm" | "no_data" | "reject" | "expired";
  readonly reason: MemoryCandidateReasonCode | null;
  readonly retention_days: number;
  readonly candidate_expires_at: string;
  readonly source_expires_at: string;
  readonly policy_digest: string;
};
export type MemoryPolicyContext = {
  readonly input: ParsedMemoryCandidateInput;
  readonly references: readonly ParsedMemoryReference[];
  readonly now: Date;
};

export function parseMemoryCandidatePolicy(value: unknown): ParsedMemoryCandidatePolicy {
  try {
    return parsePersonalOsPolicy(cloneMemoryPolicy(value));
  } catch (error) {
    if (error instanceof PersonalPolicyError) return memoryFail("MEMORY_CANDIDATE_POLICY_INVALID");
    throw error;
  }
}

function latest(values: readonly string[]): string {
  const sorted = [...values].sort();
  return sorted[sorted.length - 1] ?? memoryFail();
}

function earliest(values: readonly string[]): string {
  return [...values].sort()[0] ?? memoryFail();
}

function sourceTimes(context: MemoryPolicyContext): {
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly expires_at: string;
} {
  return {
    observed_at: latest(context.references.map(reference => reference.observed_at)),
    fresh_until: earliest(context.references.map(reference => reference.fresh_until)),
    expires_at: earliest(context.references.map(reference => reference.expires_at)),
  };
}

function contentOrigin(inputClass: ParsedMemoryCandidateInput["source"]["input_class"]): "trusted" | "retrieved" | "model" {
  switch (inputClass) {
    case "explicit_user_instruction":
    case "verified_outcome":
    case "approved_decision":
      return "trusted";
    case "labeled_inference":
    case "model_assertion":
      return "model";
    case "raw_transcript":
    case "worker_assertion":
    case "unverified_summary":
    case "transient_runtime":
    case "unlabeled_trait_inference":
      return "retrieved";
    default: {
      const exhaustive: never = inputClass;
      return exhaustive;
    }
  }
}

function mappedReason(reason: string): MemoryCandidateReasonCode {
  switch (reason) {
    case "POLICY_NOT_EFFECTIVE": return "POLICY_NOT_EFFECTIVE";
    case "POLICY_EXPIRED": return "POLICY_EXPIRED";
    case "PRINCIPAL_MISMATCH": return "PRINCIPAL_MISMATCH";
    case "PURPOSE_MISMATCH": return "PURPOSE_MISMATCH";
    case "HOST_OWNER_MISMATCH": return "HOST_OWNER_MISMATCH";
    case "PROHIBITED_PAYLOAD_FIELD": return "PROHIBITED_POLICY_FIELD";
    case "INPUT_STALE": return "SOURCE_STALE";
    case "INPUT_EXPIRED": return "SOURCE_EXPIRED";
    case "INPUT_TIME_INVALID": return "SOURCE_TIME_INVALID";
    case "RETENTION_EXCEEDED": return "RETENTION_EXPIRED";
    default: return "POLICY_DENIED";
  }
}

export function evaluateMemoryCandidatePolicy(
  policy: ParsedMemoryCandidatePolicy,
  context: MemoryPolicyContext,
): MemoryPolicyOutcome {
  const { input, now, references } = context;
  const nowMs = now.getTime();
  const policyDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.policy, policy);
  const retentionDays = policy.data_classes.memory.retention_days;
  const times = sourceTimes(context);
  const retentionExpiry = Date.parse(times.observed_at) + retentionDays * DAY_MS;
  const classificationExpiryMs = Math.min(retentionExpiry, Date.parse(policy.expires_at));
  const candidateExpiryMs = Math.max(classificationExpiryMs, nowMs + 1);
  const candidateExpiresAt = new Date(candidateExpiryMs).toISOString();
  const base = {
    retention_days: retentionDays,
    candidate_expires_at: candidateExpiresAt,
    source_expires_at: times.expires_at,
    policy_digest: policyDigest,
  };
  if (nowMs < Date.parse(policy.effective_at)) {
    return { ...base, status: "reject", reason: "POLICY_NOT_EFFECTIVE" };
  }
  if (nowMs >= Date.parse(policy.expires_at)) {
    return { ...base, status: "reject", reason: "POLICY_EXPIRED" };
  }
  if (references.some(reference => Date.parse(reference.observed_at) > nowMs)) {
    return { ...base, status: "reject", reason: "SOURCE_TIME_INVALID" };
  }
  if (references.some(reference => Date.parse(reference.expires_at) <= nowMs)) {
    return { ...base, status: "expired", reason: "SOURCE_EXPIRED" };
  }
  if (references.some(reference => Date.parse(reference.fresh_until) <= nowMs)) {
    return { ...base, status: "reject", reason: "SOURCE_STALE" };
  }
  if (classificationExpiryMs <= nowMs) {
    return { ...base, status: "expired", reason: "RETENTION_EXPIRED" };
  }
  if (input.second_brain.state === "no_data"
    && (Date.parse(input.second_brain.checked_at) > nowMs
      || Date.parse(input.second_brain.fresh_until) <= nowMs)) {
    return { ...base, status: "reject", reason: "SECOND_BRAIN_STATE_STALE" };
  }
  const decision = evaluatePersonalOsPolicy(policy, {
    action: "memory",
    data_class: "memory",
    principal_id: input.principal_id,
    purpose: input.purpose,
    sensitivity: input.sensitivity,
    host: input.host,
    client_host: null,
    observed_at: times.observed_at,
    fresh_until: earliest([times.fresh_until, candidateExpiresAt]),
    expires_at: candidateExpiresAt,
    payload_fields: input.payload_fields,
    alert_class: null,
    no_data: input.second_brain.state === "no_data",
    content_origin: contentOrigin(input.source.input_class),
    requests_policy_mutation: input.payload_fields.includes("policy"),
    requests_authority: input.source.input_class === "model_assertion",
  }, now);
  switch (decision.kind) {
    case "allow": return { ...base, status: "allow", reason: null };
    case "require_confirmation": return { ...base, status: "confirm", reason: null };
    case "abstain": return decision.reason === "NO_DATA"
      ? { ...base, status: "no_data", reason: "SECOND_BRAIN_NO_DATA" }
      : { ...base, status: "reject", reason: "POLICY_DENIED" };
    case "deny": return { ...base, status: "reject", reason: mappedReason(decision.reason) };
    case "redact": return { ...base, status: "reject", reason: "POLICY_DENIED" };
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
