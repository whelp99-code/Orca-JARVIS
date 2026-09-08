import { mkdirSync } from "node:fs";
import { ControlPlane, signCommandApproval, type StoredControlCommand } from "../../src/control-plane.js";
import { stageMemoryRememberDispatch } from "../../src/memory-remember-dispatch.js";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { stageMemoryScopeReview } from "../../src/memory-scope-review.js";
import type { MemoryScopedPublicationOptions } from "../../src/memory-scoped-write-publication.js";
import { scopedV3DispatchFixture } from "./scoped-v3-dispatch.js";
import { localKey } from "../helpers.js";

export async function scopedOutboxFixture() {
  const f = await scopedV3DispatchFixture();
  const control = new ControlPlane(f.database.authority);
  const approve = (command: StoredControlCommand) => control.decide(signCommandApproval({ schema_version: 1,
    receipt_id: `receipt:${command.request_id}`, request_id: command.request_id, decision: "approve",
    command_digest: command.command_digest, signer_principal_id: "principal:owner", authenticated_session_id: "session:fixture",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(),
    expires_at: command.expires_at, nonce: command.request_id, max_uses: 1, status: "issued" }, localKey(f.database.authority)), f.now);
  const dispatch = stageMemoryRememberDispatch(f.database.authority, f.candidate.candidate_id, f.now,
    { candidate_dispatch_spool_root: f.dispatch.roots.dispatch, candidate_review_spool_root: f.dispatch.roots.review });
  approve(dispatch);
  const claimed = control.claim(dispatch.request_id, "fixture:dispatch", f.now);
  const scope = { owner: "principal:owner" as const, projects: ["project:a"], policy_revision: "policy:1",
    valid_until: new Date(f.now.getTime() + 30000).toISOString() };
  const proposal = proposeMemoryCandidateScope(f.database.authority, f.candidate.candidate_id, scope, f.now);
  const review = stageMemoryScopeReview(f.database.authority, proposal, f.now); approve(review);
  const spoolRoot = `${f.database.root}/scoped`; mkdirSync(spoolRoot, { mode: 0o700 });
  const options: MemoryScopedPublicationOptions = { authority: f.database.authority, proposal,
    reviewRequestId: review.request_id, dispatch: f.dispatch, providerInstanceId: "provider:fixture", spoolRoot,
    clock: () => f.now, resolveWriteScope: () => ({ principal_id: scope.owner, agent_id: "agent:fixture", session_id: "session:fixture",
      provider_instance_id: "provider:fixture", method: "sb_write_request", projects: scope.projects,
      policy_revision: scope.policy_revision, valid_until: scope.valid_until }) };
  return { ...f, options, claimed, review };
}
