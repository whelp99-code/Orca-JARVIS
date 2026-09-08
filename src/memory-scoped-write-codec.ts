import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const fail = (): never => { throw new JarvisError("SCOPED_WRITE_REQUEST_INVALID"); };
function object(value: unknown, keys: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(" ") !== keys.split(" ").sort().join(" ")) return fail();
  return value as Record<string, any>;
}
function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function instant(value: unknown): number {
  if (typeof value !== "string") return fail();
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) return fail();
  return at;
}
function hash(domain: string, value: unknown) { return memoryHash(`orca-jarvis/${domain}\0`, value); }
function without(value: Record<string, any>, ...keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function freeze(value: any): any {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Bounded canonical persisted material only. Valid hashes do not grant authority,
 * consume a review, enqueue, or authorize replay. Callers must check those separately. */
export function parseMemoryScopedWriteRequestJson(raw: string, expectedProvider: string, now: Date): MemoryScopedWriteRequestMaterial {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 32768 || !Number.isFinite(now.getTime())) return fail();
    const root = object(JSON.parse(raw),
      "schema_version profile provider_instance_id operation source_request preparation writer created_at expires_at idempotency_key request_digest request_id"
    );
    if (canonicalize(root) !== raw || root.schema_version !== 4 || root.profile !== "scoped-remember-v1"
      || root.operation !== "remember" || !matches(root.provider_instance_id, id) || root.provider_instance_id !== expectedProvider) return fail();
    const source = parseSecondBrainWriteRequest(root.source_request, now);
    if (source?.schema_version !== 3 || source.operation !== "remember") return fail();
    const prep = object(root.preparation, "schema_version profile binding payload writes_authorized preparation_digest");
    const binding = object(prep.binding,
      "identity identity_digest proposal_digest idempotency_key control_request_id control_receipt_id command_digest expires_at writes_authorized");
    const scope = object(binding.identity,
      "schema_version operation candidate_id candidate_digest classification_digest source_digest owner projects policy_revision");
    if (prep.schema_version !== 1 || prep.profile !== "scoped-remember-preparation-v1" || prep.writes_authorized !== false
      || binding.writes_authorized !== false || scope.schema_version !== 1 || scope.operation !== "remember"
      || scope.owner !== "principal:owner" || !matches(scope.policy_revision, id) || !matches(scope.source_digest, digest)) return fail();
    for (const key of ["candidate_id", "candidate_digest", "classification_digest"] as const) {
      if (scope[key] !== source[key]) return fail();
    }
    if (!Array.isArray(scope.projects) || scope.projects.length > 64
      || scope.projects.some((p: unknown) => !matches(p, id) || !(p as string).startsWith("project:") || !matches((p as string).slice(8), id))
      || canonicalize(scope.projects) !== canonicalize([...new Set(scope.projects)].sort())) return fail();
    const scopeHash = hash("memory-scoped-write-identity/v1", scope);
    if (binding.identity_digest !== scopeHash || binding.idempotency_key !== `memidem:scoped:v1:${scopeHash.slice(7)}`
      || !matches(binding.proposal_digest, digest) || !matches(binding.command_digest, digest)) return fail();
    for (const key of ["control_request_id", "control_receipt_id"]) {
      const value = binding[key];
      if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512
        || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
    }
    const payload = object(prep.payload, "subject content subject_digest content_digest purpose sensitivity retention_days");
    if (payload.subject !== source.subject || payload.content !== source.payload.content || payload.purpose !== "personal_memory"
      || payload.sensitivity !== source.sensitivity || payload.retention_days !== source.retention_days
      || payload.subject_digest !== hash("memory-subject/v1", payload.subject)
      || payload.content_digest !== hash("memory-content/v1", payload.content)
      || prep.preparation_digest !== hash("memory-scoped-write-preparation/v1", without(prep, "preparation_digest"))) return fail();
    const writer = object(root.writer, "principal_id agent_id session_id");
    if (writer.principal_id !== scope.owner || !matches(writer.agent_id, id) || !matches(writer.session_id, id)) return fail();
    const expires = instant(root.expires_at);
    if (root.created_at !== source.created_at || expires <= now.getTime()
      || expires > Math.min(instant(binding.expires_at), instant(source.expires_at))) return fail();
    const key = hash("memory-scoped-write-idempotency/v4", { provider_instance_id: expectedProvider, identity_digest: scopeHash });
    const requestHash = hash("memory-scoped-write-request/v4", without(root, "request_id", "request_digest"));
    if (root.idempotency_key !== `memidem:scoped:v4:${key.slice(7)}` || root.request_digest !== requestHash
      || root.request_id !== `memreq:scoped:v4:${requestHash.slice(7)}`) return fail();
    return freeze(root) as MemoryScopedWriteRequestMaterial;
  } catch { return fail(); }
}
