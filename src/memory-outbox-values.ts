import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { JarvisError } from "./db.js";
import { resolveSpooledDispatch } from "./memory-outbox-dispatch-request.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";
import type {
  MemoryExpectedArtifactV2,
  MemoryObservation,
  MemoryObservationDigestInput,
  MemoryOutboxActionV2,
  MemoryOutboxSagaV2,
  MemorySettlementDigestInput,
  MemoryOutboxStateV2,
} from "./memory-outbox-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SID = /^[0-9a-f]{8,64}$/;
const PAGE = /^(wiki|daily|conflicts)\/[a-z0-9][a-z0-9/_-]{0,250}$/;
const WORKER = /^[A-Za-z0-9:_-]{1,128}$/;
const STATES = new Set<MemoryOutboxStateV2>([
  "queued", "claimed", "dispatching", "reconciling", "settled", "conflict", "failed", "expired",
]);
const domain = (name: string): string => `orca-jarvis/${name}/v2\0`;
export type MemoryOutboxSpoolRoots = {
  readonly candidate_dispatch_spool_root?: string;
  readonly candidate_review_spool_root?: string;
};

export function memoryOutboxHash(name: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain(name)).update(canonicalize(value)).digest("hex")}`;
}
export function memoryObservationDigest(input: MemoryObservationDigestInput): string {
  return memoryOutboxHash("memory-outbox-observation", input);
}
export function memorySettlementDigest(input: MemorySettlementDigestInput): string {
  return memoryOutboxHash("memory-outbox-settlement", {
    outbox_id: input.outbox_id, candidate_id: input.candidate_id, candidate_digest: input.candidate_digest,
    request_id: input.request_id, request_digest: input.request_digest, attempt_id: input.attempt_id,
    invocation_digest: input.invocation_digest, dispatch_fence: input.dispatch_fence,
    acceptance_receipt_digest: input.acceptance_receipt_digest, page_id: input.page_id, sid: input.sid,
    source_version: input.source_version, source_digest: input.source_digest,
    observation_digest: input.observation_digest, reconciled_at: input.reconciled_at,
  });
}
export function memoryV1Hash(name: "subject" | "content", value: unknown): string {
  return `sha256:${createHash("sha256").update(`orca-jarvis/memory-${name}/v1\0`).update(canonicalize(value)).digest("hex")}`;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  return value as Readonly<Record<string, unknown>>;
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  }
}
function artifact(value: unknown): MemoryExpectedArtifactV2 {
  const input = record(value); exact(input, ["page_id", "sid", "source_digest"]);
  const pageId = input["page_id"]; const sid = input["sid"]; const sourceDigest = input["source_digest"];
  if (typeof pageId !== "string" || !PAGE.test(pageId) || pageId.includes("..")
    || typeof sid !== "string" || !SID.test(sid)
    || typeof sourceDigest !== "string" || !DIGEST.test(sourceDigest)) {
    throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  }
  return Object.freeze({ page_id: pageId, sid, source_digest: sourceDigest });
}
export function parseMemoryOutboxAction(
  command: ClaimedControlCommand,
  now: Date,
  roots: MemoryOutboxSpoolRoots = {},
): MemoryOutboxActionV2 {
  if (command.action !== "memory.outbox.dispatch" || command.action_level < 3) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const args = record(command.args);
  const target = record(command.target); exact(target, ["candidate_id", "candidate_digest", "classification_digest"]);
  if (args["schema_version"] !== 2) throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  // Either the command names a private dispatch spool by digest, or it carries
  // the shipped inline request body.
  const spoolDigest = args["dispatch_spool_digest"];
  const spooled = spoolDigest !== undefined;
  exact(args, ["schema_version", spooled ? "dispatch_spool_digest" : "request", "expected_artifact"]);
  const candidateId = target["candidate_id"];
  if (typeof candidateId !== "string") throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  if (spooled && (typeof spoolDigest !== "string" || !DIGEST.test(spoolDigest))) {
    throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  }
  const request = spooled && typeof spoolDigest === "string"
    ? resolveSpooledDispatch({ candidate_id: candidateId, dispatch_spool_digest: spoolDigest,
      roots: { dispatch: roots.candidate_dispatch_spool_root, review: roots.candidate_review_spool_root },
      now })
    : parseSecondBrainWriteRequest(args["request"], now);
  if (request === undefined || (request.operation !== "remember" && request.operation !== "correct")) {
    throw new JarvisError("MEMORY_OUTBOX_INPUT_INVALID");
  }
  if (candidateId !== request.candidate_id || target["candidate_digest"] !== request.candidate_digest
    || target["classification_digest"] !== request.classification_digest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  return { command, request, ...(spooled && typeof spoolDigest === "string"
    ? { dispatch_spool_digest: spoolDigest } : {}),
    expected_artifact: artifact(args["expected_artifact"]) };
}
export function memoryOutboxIdentity(action: MemoryOutboxActionV2): { outbox_id: string; digest: string } {
  const request = action.request; const digest = memoryOutboxHash("memory-outbox", {
    candidate_id: request.candidate_id, candidate_digest: request.candidate_digest,
    classification_digest: request.classification_digest, request_id: request.request_id,
    request_digest: request.request_digest, idempotency_key: request.idempotency_key,
    operation: request.operation, expected_artifact: action.expected_artifact,
  });
  return { outbox_id: `memout:pos:v2:${digest.slice(7)}`, digest };
}
export function memoryInvocation(outboxId: string, requestDigest: string, fence: number): { attempt_id: string; digest: string } {
  const digest = memoryOutboxHash("memory-outbox-invocation", {
    outbox_id: outboxId, request_digest: requestDigest, attempt_number: 1, dispatch_fence: fence,
  });
  return { attempt_id: `memattempt:pos:v2:${digest.slice(7)}`, digest };
}
export function requireWorker(value: string): string {
  if (!WORKER.test(value)) throw new JarvisError("MEMORY_OUTBOX_WORKER_INVALID");
  return value;
}
export function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new JarvisError("MEMORY_OUTBOX_LIMIT_INVALID");
  return value;
}
export function requireDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new TypeError("MEMORY_OUTBOX_CONFIG_INVALID");
  return value;
}
export function parseSagaRow(value: unknown): MemoryOutboxSagaV2 {
  const row = record(value); const state = row["state"];
  if (row["request_profile"] !== undefined && row["request_profile"] !== "legacy") {
    throw new JarvisError("MEMORY_OUTBOX_PROFILE_UNSUPPORTED");
  }
  if (typeof state !== "string" || !STATES.has(state as MemoryOutboxStateV2)
    || typeof row["outbox_id"] !== "string" || typeof row["candidate_id"] !== "string"
    || typeof row["request_id"] !== "string" || typeof row["request_digest"] !== "string"
    || (row["operation"] !== "remember" && row["operation"] !== "correct")
    || typeof row["expected_page_id"] !== "string" || typeof row["expected_sid"] !== "string"
    || typeof row["expected_artifact_digest"] !== "string") throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE");
  return {
    schema_version: 2, outbox_id: row["outbox_id"], candidate_id: row["candidate_id"],
    candidate_digest: String(row["candidate_digest"]), classification_digest: String(row["classification_digest"]),
    request_id: row["request_id"], request_digest: row["request_digest"], operation: row["operation"],
    expected_artifact: { page_id: row["expected_page_id"], sid: row["expected_sid"], source_digest: row["expected_artifact_digest"] },
    state: state as MemoryOutboxStateV2, lease_owner: typeof row["lease_owner"] === "string" ? row["lease_owner"] : null,
    lease_fence: Number(row["lease_fence"]), dispatch_fence: typeof row["dispatch_fence"] === "number" ? row["dispatch_fence"] : null,
    dispatched_at: typeof row["dispatched_at"] === "string" ? row["dispatched_at"] : null,
    reconcile_deadline_at: typeof row["reconcile_deadline_at"] === "string" ? row["reconcile_deadline_at"] : null,
    failure_code: typeof row["failure_code"] === "string" ? row["failure_code"] : null,
    settlement_receipt_digest: typeof row["settlement_receipt_digest"] === "string" ? row["settlement_receipt_digest"] : null,
    settled_at: typeof row["settled_at"] === "string" ? row["settled_at"] : null,
    created_at: String(row["created_at"]), updated_at: String(row["updated_at"]),
  };
}

/** Settlement receipt for a reconciled outbox saga, or null while it is not yet settled. */
export function memoryOutboxSettlementReceipt(input: {
  readonly saga: MemoryOutboxSagaV2;
  readonly observation: MemoryObservation;
  readonly attempt: { readonly attempt_id: string; readonly invocation_digest: string;
    readonly acceptance_receipt_digest: string | null };
  readonly settled: { readonly observationDigest: string; readonly at: string };
}): string {
  const { saga, observation, attempt } = input;
  if (saga.dispatch_fence === null || observation.page_id === undefined || observation.sid === undefined
    || observation.source_version === undefined || observation.source_digest === undefined) {
    throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE");
  }
  return memorySettlementDigest({
    outbox_id: saga.outbox_id, candidate_id: saga.candidate_id, candidate_digest: saga.candidate_digest,
    request_id: saga.request_id, request_digest: saga.request_digest, attempt_id: attempt.attempt_id,
    invocation_digest: attempt.invocation_digest, dispatch_fence: saga.dispatch_fence,
    acceptance_receipt_digest: attempt.acceptance_receipt_digest,
    page_id: observation.page_id, sid: observation.sid, source_version: observation.source_version,
    source_digest: observation.source_digest, observation_digest: input.settled.observationDigest,
    reconciled_at: input.settled.at,
  });
}
