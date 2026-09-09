import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";

export interface SecondBrainScopedWriteAccepted {
  readonly schema_version: 4;
  readonly kind: "accepted";
  readonly state: "pending";
  readonly provider_instance_id: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly scope_digest: string;
  readonly accepted_at: string;
  readonly inbox_path: string;
  readonly request_file_digest: string;
  readonly replayed: boolean;
}
const keys = "accepted_at idempotency_key inbox_path kind provider_instance_id replayed request_digest "
  + "request_file_digest request_id schema_version scope_digest state";
/** Internal V4 response validation, not a public transport profile or authority
 * verifier. Historical decoding permits a delayed acknowledgement after expiry. */
export function parseSecondBrainScopedWriteAccepted(value: unknown, expected: MemoryScopedWriteRequestMaterial,
  observedAt: Date): SecondBrainScopedWriteAccepted {
  const fail = (): never => { throw new JarvisError("SECOND_BRAIN_SCOPED_ACCEPTANCE_INVALID"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(" ") !== keys
    || !Number.isFinite(observedAt.getTime())) return fail();
  const row = { ...value } as Record<string, unknown>;
  const acceptedAt = typeof row.accepted_at === "string" ? Date.parse(row.accepted_at) : NaN;
  if (!Number.isFinite(acceptedAt) || new Date(acceptedAt).toISOString() !== row.accepted_at
    || acceptedAt > observedAt.getTime()) return fail();
  const request = parseMemoryScopedWriteRequestJson(canonicalize(expected), expected.provider_instance_id, new Date(acceptedAt));
  if (row.schema_version !== 4 || row.kind !== "accepted" || row.state !== "pending" || typeof row.replayed !== "boolean"
    || row.provider_instance_id !== request.provider_instance_id || row.request_id !== request.request_id
    || row.request_digest !== request.request_digest || row.idempotency_key !== request.idempotency_key
    || row.scope_digest !== request.preparation.binding.identity_digest
    || row.inbox_path !== `pending/${request.request_id}.v4.json`
    || row.request_file_digest !== memoryHash("second-brain/inbox-write-request/v4\0", {
      schema_version: 4, state: "pending", accepted_at: row.accepted_at, request })) return fail();
  return Object.freeze(row) as unknown as SecondBrainScopedWriteAccepted;
}
