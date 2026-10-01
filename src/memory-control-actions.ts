import type { RuntimeControlActionInput } from "./control-actions.js";
import { JarvisError } from "./db.js";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const memoryBindingKeys = [
  "schema_version", "candidate_id", "correlation_id", "subject_digest", "content_digest",
  "source_id", "source_version", "operation", "purpose", "sensitivity",
] as const;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function requireOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}
function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (!nonempty(item)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  return item;
}
function requireRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = value[key];
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
  return item as Record<string, unknown>;
}
function bindTarget(target: Record<string, unknown>, key: string, expected: string): void {
  if (!(key in target)) return;
  if (target[key] !== expected) throw new JarvisError("CONTROL_TARGET_MISMATCH");
}

export function memoryConfirm(input: RuntimeControlActionInput): void {
  requireOnly(input.target, ["candidate_id", "candidate_digest", "classification_digest"]);
  if (input.args.schema_version !== 1
    || !/^memcand:pos:v1:[0-9a-f]{64}$/.test(String(input.target.candidate_id))
    || !digest.test(String(input.target.candidate_digest))
    || !digest.test(String(input.target.classification_digest))) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
  // Two confirmation shapes are authoritative: the evidence-bound correction
  // command and the owner-decision command the Memory surface stages.
  if (Object.hasOwn(input.args, "evidence_digest")) {
    requireOnly(input.args, ["schema_version", "operation", "evidence_digest"]);
    if (input.args.operation !== "correct" || !digest.test(String(input.args.evidence_digest))) {
      throw new JarvisError("CONTROL_ARGS_MISMATCH");
    }
    return;
  }
  requireOnly(input.args, ["schema_version", "operation", "decision", "content_digest", "review_spool_digest"]);
  if ((input.args.operation !== "remember" && input.args.operation !== "correct")
    || (input.args.decision !== "confirm" && input.args.decision !== "reject")
    || !digest.test(String(input.args.content_digest))
    || !digest.test(String(input.args.review_spool_digest))) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}

function memorySurfaceEffect(input: RuntimeControlActionInput, operation: "correct" | "forget" | "export"): void {
  requireOnly(input.target, ["record_selection_digest", "provider_instance_id", "operation"]);
  requireOnly(input.args, ["schema_version", "intent_digest", "semantic_digest", "policy_digest",
    "expected_prior_digest", "target_manifest_digest", "scope_digest", "target_version_digest",
    "suppression_epoch", "selection_expires_at", "payload"]);
  const payload = requireRecord(input.args, "payload");
  requireOnly(payload, ["kind", "payload_digest"]);
  if (input.args.schema_version !== 1 || input.target.operation !== operation || payload.kind !== operation
    || !nonempty(input.target.provider_instance_id) || !digest.test(String(input.target.record_selection_digest))
    || !digest.test(String(input.args.semantic_digest)) || !digest.test(String(input.args.policy_digest))
    || !digest.test(String(input.args.expected_prior_digest))
    || !digest.test(String(input.args.target_manifest_digest)) || !digest.test(String(input.args.scope_digest))
    || !digest.test(String(input.args.target_version_digest)) || !digest.test(String(payload.payload_digest))
    || !Number.isSafeInteger(input.args.suppression_epoch) || !nonempty(input.args.selection_expires_at)) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}

function inlineDispatchBound(
  request: Record<string, unknown>,
  target: Record<string, unknown>,
): boolean {
  return request.operation === "remember" && request.candidate_id === target.candidate_id
    && request.candidate_digest === target.candidate_digest
    && request.classification_digest === target.classification_digest;
}

export function memoryOutboxAbandonNotDelivered(input: RuntimeControlActionInput): void {
  requireOnly(input.target, ["outbox_id"]);
  requireOnly(input.args, ["schema_version", "outbox_id"]);
  const outboxId = requireString(input.args, "outbox_id");
  if (input.args.schema_version !== 1 || input.target.outbox_id !== outboxId
    || !/^memout:pos:v2:[0-9a-f]{64}$/.test(outboxId)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
}

export function memoryOutboxDispatch(input: RuntimeControlActionInput): void {
  if (input.args.schema_version === 1) { memorySurfaceEffect(input, "correct"); return; }
  requireOnly(input.target, ["candidate_id", "candidate_digest", "classification_digest"]);
  if (input.args.schema_version === 2) {
    // The spool-digest form carries no request body; the inline-request form is
    // the shipped shape and stays authoritative.
    const spooled = Object.hasOwn(input.args, "dispatch_spool_digest");
    requireOnly(input.args, ["schema_version", spooled ? "dispatch_spool_digest" : "request",
      "expected_artifact", "confirm_binding"]);
    if (input.args.confirm_binding !== undefined) {
      const binding = requireRecord(input.args, "confirm_binding");
      requireOnly(binding, ["confirm_request_id", "confirm_receipt_id", "confirm_command_digest", "approved_candidate_digest"]);
      if (!digest.test(String(binding.confirm_command_digest)) || !digest.test(String(binding.approved_candidate_digest))
        || binding.approved_candidate_digest !== input.target.candidate_digest) {
        throw new JarvisError("CONTROL_ARGS_MISMATCH");
      }
    }
    const expected = requireRecord(input.args, "expected_artifact");
    requireOnly(expected, ["page_id", "sid", "source_digest"]);
    const bound = spooled
      ? digest.test(String(input.args.dispatch_spool_digest))
      : inlineDispatchBound(requireRecord(input.args, "request"), input.target);
    if (!bound
      || !/^memcand:pos:v1:[0-9a-f]{64}$/.test(String(input.target.candidate_id))
      || !digest.test(String(input.target.candidate_digest))
      || !digest.test(String(input.target.classification_digest))
      || !nonempty(expected.page_id) || !nonempty(expected.sid) || !nonempty(expected.source_digest)) {
      throw new JarvisError("CONTROL_ARGS_MISMATCH");
    }
    return;
  }
  requireOnly(input.args, ["schema_version", "lane", "lane_id", "provider_instance_id",
    "target_manifest_digest", "scope_digest", "payload_digest", "spool_digest", "expires_at"]);
  if (input.args.schema_version !== 3 || input.args.lane !== "correction"
    || !/^memcorr:req:v1:[0-9a-f]{64}$/.test(String(input.args.lane_id))
    || !nonempty(input.args.provider_instance_id)
    || !digest.test(String(input.args.target_manifest_digest))
    || !digest.test(String(input.args.scope_digest))
    || !digest.test(String(input.args.payload_digest))
    || !digest.test(String(input.args.spool_digest)) || !nonempty(input.args.expires_at)) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}

export function memoryDedicatedEffect(input: RuntimeControlActionInput,
  lane: "deletion" | "export"): void {
  if (input.args.schema_version === 1) {
    memorySurfaceEffect(input, lane === "deletion" ? "forget" : "export"); return;
  }
  const identity = lane === "deletion" ? "deletion_id" : "export_id";
  requireOnly(input.target, [identity, "target_manifest_digest", "scope_digest"]);
  requireOnly(input.args, ["schema_version", "lane", "lane_id", "provider_instance_id",
    "target_manifest_digest", "scope_digest", "payload_digest", "spool_digest", "expires_at"]);
  const prefix = lane === "deletion" ? /^memdel:req:v1:[0-9a-f]{64}$/
    : /^memexp:req:v1:[0-9a-f]{64}$/;
  if (input.args.schema_version !== 3 || input.args.lane !== lane
    || !prefix.test(String(input.args.lane_id)) || !nonempty(input.args.provider_instance_id)
    || !digest.test(String(input.args.target_manifest_digest))
    || !digest.test(String(input.args.scope_digest))
    || !digest.test(String(input.args.payload_digest))
    || !digest.test(String(input.args.spool_digest)) || !nonempty(input.args.expires_at)
    || !nonempty(input.target[identity])
    || input.target.target_manifest_digest !== input.args.target_manifest_digest
    || input.target.scope_digest !== input.args.scope_digest) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}

export function memoryGenerationRollback(input: RuntimeControlActionInput): void {
  requireOnly(input.target, ["provider_instance_id", "generation_id"]);
  requireOnly(input.args, ["schema_version", "provider_instance_id", "generation_id", "reason"]);
  if (input.args.schema_version !== 1) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  const provider = requireString(input.args, "provider_instance_id");
  const generation = requireString(input.args, "generation_id");
  requireString(input.args, "reason");
  bindTarget(input.target, "provider_instance_id", provider);
  bindTarget(input.target, "generation_id", generation);
}

export function memoryAuthority(input: RuntimeControlActionInput,
  identityKey: "instruction_id" | "decision_id"): void {
  requireOnly(input.target, ["candidate_id", "correlation_id"]);
  requireOnly(input.args, [...memoryBindingKeys, identityKey]);
  const candidate = requireString(input.args, "candidate_id");
  const correlation = requireString(input.args, "correlation_id");
  if (input.args.schema_version !== 1 || !/^memcand:pos:v1:[0-9a-f]{64}$/.test(candidate)
    || !/^corr:memory:[0-9a-f]{64}$/.test(correlation)
    || !digest.test(requireString(input.args, "subject_digest"))
    || !digest.test(requireString(input.args, "content_digest"))
    || !opaque.test(requireString(input.args, "source_id"))
    || !opaque.test(requireString(input.args, "source_version"))
    || !opaque.test(requireString(input.args, identityKey))
    || (input.args.operation !== "remember" && input.args.operation !== "correct")
    || input.args.purpose !== "personal_memory"
    || !["public", "personal", "sensitive", "restricted"].includes(String(input.args.sensitivity))) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
  if (input.target.candidate_id !== candidate || input.target.correlation_id !== correlation) {
    throw new JarvisError("CONTROL_TARGET_MISMATCH");
  }
}
