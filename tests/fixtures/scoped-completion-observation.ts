import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { rememberedArtifactExpectation } from "../../src/second-brain-remembered-artifact.js";
import { scopedOutboxFixture } from "./scoped-outbox.js";

import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";
import { observeMemoryScopedCompletion } from "../../src/memory-scoped-completion-observation.js";
import { claimMemoryScopedReconciliation } from "../../src/memory-scoped-reconciliation.js";

import { memoryHash } from "../../src/memory-candidate-values.js";

async function setup() {
  const f = await scopedOutboxFixture();
  const r = registerMemoryScopedOutbox(f.options, f.claimed), options = { ...f.options, roots: f.dispatch.roots };
  const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:fixture", 1000)!;
  const dispatch = markMemoryScopedOutboxDispatch(options, lease, 30000), request = dispatch.request;
  const accepted_at = f.now.toISOString();
  const accepted = { schema_version: 4, kind: "accepted", state: "pending", provider_instance_id: request.provider_instance_id,
    request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
    scope_digest: request.preparation.binding.identity_digest, accepted_at, inbox_path: `pending/${request.request_id}.v4.json`,
    request_file_digest: memoryHash("second-brain/inbox-write-request/v4\0", { schema_version: 4, state: "pending", accepted_at, request }), replayed: false };
  return { ...f, dispatch, accepted };
}


export async function completionObservationFixture() {
  const f = await setup(), at = new Date(f.now.getTime() + 60000), request = f.dispatch.request;
  recoverMemoryScopedOutboxDispatches(f.database.authority, at);
  const leased = claimMemoryScopedReconciliation(f.options, f.dispatch.outbox_id, "worker:observe", at, 10000)!;
  const expected = rememberedArtifactExpectation(request, f.accepted, at);
  const hash = (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex");
  const proof = { schema_version: 4, provider_instance_id: request.provider_instance_id, request_id: request.request_id,
    request_digest: request.request_digest, scope_digest: request.preparation.binding.identity_digest,
    content_digest: hash(request.preparation.payload.content), generation_id: "sbgen:v1:" + "a".repeat(64),
    head: "b".repeat(40), tree: "c".repeat(40) };
  const proof_digest = memoryHash("second-brain/memory-surface-manifest/v1\0", proof);
  const receipt = { schema_version: 4, request_id: request.request_id, request_digest: request.request_digest,
    envelope_digest: null, state: "proved", code: "PROVIDER_PROVED", proof_digest,
    status_digest: memoryHash("second-brain/memory-surface-manifest/v1\0", { state: "proved", proof: proof_digest }),
    updated_at: f.now.toISOString() };
  const classification = { schema_version: 1, owner: expected.owner, projects: expected.projects, policy_revision: expected.policy };
  const source = { source_ref_digest: expected.source_ref_digest, classification,
    classification_digest: hash("second-brain/source-access-classification/v1\0" + expected.source_ref_digest + "\0" + canonicalize(classification)) };
  const status = { schema_version: 4, provider_instance_id: request.provider_instance_id, request_id: request.request_id,
    request_digest: request.request_digest, scope_digest: proof.scope_digest, state: "proved", phase: "proved",
    updated_at: receipt.updated_at, proof, receipt, acceptance: { ...f.accepted, replayed: true } };
  const artifact = { kind: "remembered_artifact_observed", request_id: request.request_id, request_digest: request.request_digest,
    page_id: expected.page_id, content_digest: hash("fixture-page"), access: { schema_version: 1, complete: true, sources: [source] },
    generation: { provider_instance_id: request.provider_instance_id, generation_id: proof.generation_id,
      generation_manifest_digest: "sha256:" + "a".repeat(64), vault_head: proof.head, vault_tree: proof.tree,
      tombstone_sequence: 0, tombstone_set_root: hash("fixture-root") },
    record_ids: expected.lines.map((_, i) => "sbrecord:v1:" + hash(String(i)).slice(7)) };
  const value = { kind: "remembered_completion_observed", request_id: request.request_id, request_digest: request.request_digest,
    status, artifact, checked_at: at.toISOString(), valid_until: new Date(at.getTime() + 5000).toISOString() };
  const client = { withRememberedCompletion: async (_request: unknown, consume: any) => consume(value, () => value) };
  const recorded = await observeMemoryScopedCompletion(f.options, leased.lease, client, () => at);
  return { ...f, at, recorded, leased, client, observation: value };
}
