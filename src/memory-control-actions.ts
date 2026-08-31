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
  requireOnly(input.args, ["schema_version", "operation", "evidence_digest"]);
  if (input.args.schema_version !== 1 || input.args.operation !== "correct"
    || !/^memcand:pos:v1:[0-9a-f]{64}$/.test(String(input.target.candidate_id))
    || !digest.test(String(input.target.candidate_digest))
    || !digest.test(String(input.target.classification_digest))
    || !digest.test(String(input.args.evidence_digest))) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
}

export function memoryOutboxDispatch(input: RuntimeControlActionInput): void {
  requireOnly(input.target, ["candidate_id", "candidate_digest", "classification_digest"]);
  if (input.args.schema_version === 2) {
    requireOnly(input.args, ["schema_version", "request", "expected_artifact"]);
    const request = requireRecord(input.args, "request");
    const expected = requireRecord(input.args, "expected_artifact");
    requireOnly(expected, ["page_id", "sid", "source_digest"]);
    if (request.operation !== "remember" || request.candidate_id !== input.target.candidate_id
      || request.candidate_digest !== input.target.candidate_digest
      || request.classification_digest !== input.target.classification_digest
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
