import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { requireMemoryOutboxAuthority } from "./memory-outbox-authority.js";
import { MemoryOutboxRecordReader } from "./memory-outbox-record.js";
import { parseMemoryOutboxAction } from "./memory-outbox-values.js";
import { readRegisteredMemoryScopeReview } from "./memory-scope-review.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import type { MemoryScopedPublicationOptions } from "./memory-scoped-write-publication.js";
import { MemoryScopedWriteSpool } from "./memory-scoped-write-spool.js";
import { hasRegisteredScopedSourceAuthority } from "./second-brain-write-authority.js";

type Options = Pick<MemoryScopedPublicationOptions, "authority" | "resolveWriteScope" | "providerInstanceId" | "spoolRoot" | "clock">
  & { readonly roots: { readonly dispatch?: string; readonly review?: string } };

/** Reconstruct registered bytes with current source/review/policy checks. No
 * claim, dispatch, provider acceptance or reusable grant is produced here. */
export function readCurrentMemoryScopedOutbox(options: Options, outboxId: string) {
  const fail = (): never => { throw new JarvisError("SCOPED_OUTBOX_CURRENT_REQUEST_INVALID"); };
  let previous = Number.NEGATIVE_INFINITY;
  const clock = () => {
    const at = options.clock().getTime();
    if (!Number.isFinite(at) || at < previous) return fail();
    previous = at; return new Date(at);
  };
  return options.authority.db.transaction(() => {
    const db = options.authority.db;
    const row = db.prepare(`SELECT o.*,b.provider_instance_id,b.scope_digest,b.scope_review_request_id,
      b.scope_review_receipt_id,b.scope_command_digest,b.source_request_id,b.source_request_digest
      FROM memory_outbox o JOIN memory_scoped_outbox_bindings b ON b.outbox_id=o.outbox_id
      AND b.candidate_id=o.candidate_id AND b.request_id=o.request_id AND b.request_digest=o.request_digest
      AND b.idempotency_key=o.idempotency_key AND b.created_at=o.created_at WHERE o.outbox_id=?`).get(outboxId) as
      Record<string, unknown> | undefined;
    if (row === undefined || row.request_profile !== "scoped-v4" || row.provider_instance_id !== options.providerInstanceId
      || (row.state !== "queued" && row.state !== "claimed")) return fail();
    const spool = new MemoryScopedWriteSpool(options.spoolRoot, options.providerInstanceId);
    const request = spool.read(String(row.idempotency_key), clock());
    const raw = canonicalize(request), source = request.source_request, binding = request.preparation.binding;
    if (row.request_id !== request.request_id || row.request_digest !== request.request_digest
      || row.candidate_id !== source.candidate_id || row.candidate_digest !== source.candidate_digest
      || row.classification_digest !== source.classification_digest || row.operation !== source.operation
      || row.source_request_id !== source.request_id || row.source_request_digest !== source.request_digest
      || row.expires_at !== request.expires_at || row.scope_digest !== binding.identity_digest
      || row.scope_review_request_id !== binding.control_request_id || row.scope_review_receipt_id !== binding.control_receipt_id
      || row.scope_command_digest !== binding.command_digest) return fail();
    const command = new MemoryOutboxRecordReader(options.authority).command(outboxId);
    if (command.request_id !== row.action_request_id || command.receipt_id !== row.action_receipt_id
      || command.command_digest !== row.action_command_digest) return fail();
    const readAction = () => {
      const action = parseMemoryOutboxAction(command, clock(), { candidate_dispatch_spool_root: options.roots.dispatch,
        candidate_review_spool_root: options.roots.review });
      if (canonicalize(action.request) !== canonicalize(source) || action.expected_artifact.page_id !== row.expected_page_id
        || action.expected_artifact.sid !== row.expected_sid || action.expected_artifact.source_digest !== row.expected_artifact_digest
        || `memout:scoped:v4:${memoryHash("orca-jarvis/memory-scoped-outbox/v4\0", {
          request_id: request.request_id, request_digest: request.request_digest,
          expected_artifact: action.expected_artifact }).slice(7)}` !== outboxId) return fail();
      return action;
    };
    const check = (action: ReturnType<typeof readAction>) => {
      const scope = options.resolveWriteScope(clock());
      const at = clock();
      parseMemoryScopedWriteRequestJson(raw, options.providerInstanceId, at);
      if (scope === undefined) return fail();
      const identity = binding.identity;
      if (scope.method !== "sb_write_request" || scope.provider_instance_id !== options.providerInstanceId
        || scope.principal_id !== request.writer.principal_id || scope.agent_id !== request.writer.agent_id
        || scope.session_id !== request.writer.session_id || scope.policy_revision !== identity.policy_revision
        || !(Date.parse(scope.valid_until) > at.getTime())
        || (!identity.projects.length && scope.projects.length > 0)
        || !identity.projects.every(project => scope.projects.includes(project))) return fail();
      const reviewCommand = new ControlPlane(options.authority).get(binding.control_request_id);
      const review = readRegisteredMemoryScopeReview(options.authority, reviewCommand?.args.proposal,
        binding.control_request_id, outboxId, at);
      const proposal = review.proposal;
      const expectedIdentity = { schema_version: 1, operation: "remember", candidate_id: proposal.candidate_id,
        candidate_digest: proposal.candidate_digest, classification_digest: proposal.classification_digest,
        source_digest: proposal.source_digest, owner: proposal.scope.owner, projects: proposal.scope.projects,
        policy_revision: proposal.scope.policy_revision };
      if (canonicalize(identity) !== canonicalize(expectedIdentity) || binding.proposal_digest !== proposal.proposal_digest
        || binding.expires_at !== review.expires_at || binding.control_receipt_id !== review.control_receipt_id
        || binding.command_digest !== review.command_digest) return fail();
      requireMemoryOutboxAuthority(options.authority, action, at, false);
      if (!hasRegisteredScopedSourceAuthority(options.authority, source, outboxId, at)) return fail();
    };
    check(readAction());
    if (canonicalize(spool.read(request.idempotency_key, clock())) !== raw) return fail();
    // All private file reads precede the final policy callback. Persisted review
    // and source checks follow that callback under the same writer transaction.
    check(readAction());
    return request;
  }).immediate();
}
