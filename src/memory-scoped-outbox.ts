import { canonicalize } from "./canonical.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { requireMemoryOutboxAuthority } from "./memory-outbox-authority.js";
import { MemoryOutboxRecordReader } from "./memory-outbox-record.js";
import { parseMemoryOutboxAction } from "./memory-outbox-values.js";
import { publishMemoryScopedWriteRequest, type MemoryScopedPublicationOptions } from "./memory-scoped-write-publication.js";
import { prepareMemoryScopedWriteRequest } from "./memory-scoped-write-request.js";
import { MemoryScopedWriteSpool } from "./memory-scoped-write-spool.js";

type Binding = { outbox_id: string; request_id: string; request_digest: string; idempotency_key: string;
  provider_instance_id: string; scope_review_request_id: string; created_at: string };
function result(binding: Binding, replayed: boolean) {
  return Object.freeze({ schema_version: 4 as const, kind: "registered" as const, state: "queued" as const,
    outbox_id: binding.outbox_id, request_id: binding.request_id, request_digest: binding.request_digest,
    idempotency_key: binding.idempotency_key, registered_at: binding.created_at, replayed });
}

/** Trusted internal registration, not a provider dispatch surface. Uses the
 * existing claimed dispatch authority and consumes its signed scope review once.
 * Replay is a read-back of committed registration, never renewed write authority. */
export function registerMemoryScopedOutbox(options: MemoryScopedPublicationOptions, command: ClaimedControlCommand) {
  const db = options.authority.db;
  let previous = Number.NEGATIVE_INFINITY;
  const clock = () => {
    const at = options.clock().getTime();
    if (!Number.isFinite(at) || at < previous) throw new JarvisError("SCOPED_OUTBOX_TIME_INVALID");
    previous = at; return new Date(at);
  };
  return db.transaction(() => {
    const existing = db.prepare(`SELECT b.* FROM memory_scoped_outbox_bindings b
      JOIN memory_outbox o ON o.outbox_id=b.outbox_id WHERE o.action_request_id=?`).get(command.request_id) as Binding | undefined;
    if (existing !== undefined) {
      const stored = new MemoryOutboxRecordReader(options.authority).command(existing.outbox_id);
      const review = new ControlPlane(options.authority).get(options.reviewRequestId);
      const storedIdentity = { ...stored, lease_expires_at: null };
      const inputIdentity = { ...command, lease_expires_at: null };
      if (canonicalize(storedIdentity) !== canonicalize(inputIdentity) || existing.scope_review_request_id !== options.reviewRequestId
        || existing.provider_instance_id !== options.providerInstanceId
        || review === undefined || canonicalize(review.args.proposal) !== canonicalize(options.proposal)) throw new JarvisError("SCOPED_OUTBOX_REPLAY_CONFLICT");
      return result(existing, true);
    }
    const publication = publishMemoryScopedWriteRequest({ ...options, clock });
    const request = new MemoryScopedWriteSpool(options.spoolRoot, options.providerInstanceId).read(publication.idempotency_key, clock());
    let at = clock();
    const prepared = prepareMemoryScopedWriteRequest(options.authority, options.proposal, options.reviewRequestId,
      options.dispatch, options.resolveWriteScope, options.providerInstanceId, at);
    if (canonicalize(prepared) !== canonicalize(request)) throw new JarvisError("SCOPED_OUTBOX_REQUEST_CHANGED");
    const action = parseMemoryOutboxAction(command, at, { candidate_dispatch_spool_root: options.dispatch.roots.dispatch,
      candidate_review_spool_root: options.dispatch.roots.review });
    if (canonicalize(action.request) !== canonicalize(request.source_request)) throw new JarvisError("SCOPED_OUTBOX_SOURCE_MISMATCH");
    at = clock();
    const confirmed = prepareMemoryScopedWriteRequest(options.authority, options.proposal, options.reviewRequestId,
      options.dispatch, options.resolveWriteScope, options.providerInstanceId, at);
    if (canonicalize(confirmed) !== canonicalize(request)) throw new JarvisError("SCOPED_OUTBOX_REQUEST_CHANGED");
    requireMemoryOutboxAuthority(options.authority, action, at);
    const current = new ControlPlane(options.authority).get(command.request_id);
    const lease = db.prepare("SELECT lease_fence,lease_expires_at FROM control_command_requests WHERE request_id=?")
      .get(command.request_id) as { lease_fence: number; lease_expires_at: string } | undefined;
    if (current?.state !== "claimed" || lease?.lease_fence !== command.fence
      || lease.lease_expires_at !== command.lease_expires_at || Date.parse(command.lease_expires_at) <= at.getTime()
      || current.command_digest !== command.command_digest || current.action !== command.action
      || current.action_level !== command.action_level || current.reversible !== command.reversible
      || canonicalize(current.args) !== canonicalize(command.args) || canonicalize(current.target) !== canonicalize(command.target)) {
      throw new JarvisError("SCOPED_OUTBOX_CLAIM_INVALID");
    }
    const source = request.source_request, scope = request.preparation.binding;
    const id = memoryHash("orca-jarvis/memory-scoped-outbox/v4\0", {
      request_id: request.request_id, request_digest: request.request_digest, expected_artifact: action.expected_artifact });
    const outboxId = `memout:scoped:v4:${id.slice(7)}`;
    const createdAt = at.toISOString();
    db.prepare(`INSERT INTO memory_scoped_outbox_bindings(outbox_id,candidate_id,request_id,request_digest,idempotency_key,
      provider_instance_id,scope_digest,scope_review_request_id,scope_review_receipt_id,scope_command_digest,
      source_request_id,source_request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(outboxId, source.candidate_id,
      request.request_id, request.request_digest, request.idempotency_key, options.providerInstanceId, scope.identity_digest,
      scope.control_request_id, scope.control_receipt_id, scope.command_digest, source.request_id, source.request_digest, createdAt);
    db.prepare(`INSERT INTO memory_outbox(outbox_id,candidate_id,action_request_id,action_receipt_id,action_command_digest,
      idempotency_key,request_id,request_digest,candidate_digest,classification_digest,operation,expected_page_id,expected_sid,
      expected_artifact_digest,state,expires_at,created_at,updated_at,request_profile)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,'scoped-v4')`).run(outboxId, source.candidate_id,
      command.request_id, command.receipt_id, command.command_digest, request.idempotency_key, request.request_id,
      request.request_digest, source.candidate_digest, source.classification_digest, "remember", action.expected_artifact.page_id,
      action.expected_artifact.sid, action.expected_artifact.source_digest, request.expires_at, createdAt, createdAt);
    return result({ outbox_id: outboxId, request_id: request.request_id, request_digest: request.request_digest,
      idempotency_key: request.idempotency_key, provider_instance_id: options.providerInstanceId,
      scope_review_request_id: options.reviewRequestId, created_at: createdAt }, false);
  }).immediate();
}
