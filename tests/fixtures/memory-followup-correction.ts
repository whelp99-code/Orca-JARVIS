import { ControlPlane, ApprovedCommandExecutor, MemoryCandidateStore, signCommandApproval,
  type ControlCommandRequestInput, type CommandApprovalReceipt } from "../../src/index.js";
import type { AuthorityDb } from "../../src/db.js";
import { MemoryCorrectionSaga, type MemoryCorrectionSagaOptions } from "../../src/memory-correction-saga.js";
import type { ResolvedMemoryTargetV2, MemoryEffectScopeV2 } from "../../src/second-brain-effect-v2.js";
import { localKey } from "../helpers.js";
import { memoryPolicy, verifiedMemoryInput } from "./memory-candidate-fixture.js";
import { insertMemoryVerification, memoryVerificationPayload } from "./memory-candidate-store.js";

/** Fixture authority evidence, followed exclusively by real command/saga APIs. */
export async function dispatchFollowupCorrection(db: AuthorityDb, runtime: MemoryCorrectionSagaOptions,
  target: ResolvedMemoryTargetV2, scope: MemoryEffectScopeV2, content: string, namespace = "followup") {
  const now = runtime.clock();
  const expires = new Date(now.getTime() + 60_000).toISOString();
  const control = new ControlPlane(db);
  const input = verifiedMemoryInput({ authority_id: namespace, idempotency_key: `candidate:${namespace}`,
    operation: "correct" });
  insertMemoryVerification(db, memoryVerificationPayload(input, { issued_at: now.toISOString(),
    not_before: now.toISOString(), expires_at: expires }));
  const candidate = new MemoryCandidateStore(db, memoryPolicy(), () => now).classify(input);
  function approve(action: ControlCommandRequestInput) {
    const staged = control.stage(action, now);
    const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
      receipt_id: `approval:${action.request_id}`, request_id: action.request_id, decision: "approve",
      command_digest: staged.command_digest, signer_principal_id: "principal:owner", authenticated_session_id: "task30",
      key_id: "decision-test", algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
      expires_at: expires, nonce: `approval:${namespace}:${action.request_id}`, max_uses: 1, status: "issued" };
    control.decide(signCommandApproval(receipt, localKey(db)), now);
  }
  const confirmation: ControlCommandRequestInput = { schema_version: 1, request_id: `${namespace}:confirm`,
    action: "memory.confirm", action_level: 3, target: { candidate_id: candidate.candidate_id,
      candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest },
    args: { schema_version: 1, operation: "correct", evidence_digest: `sha256:${"b".repeat(64)}` },
    reversible: false, requested_by: "principal:owner", requested_at: now.toISOString(), expires_at: expires,
    nonce: `${namespace}:confirm` };
  approve(confirmation);
  const confirmed = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => now)
    .execute(confirmation.request_id, "fixture", now);
  if (confirmed.state !== "completed") throw new Error("FOLLOWUP_CONFIRMATION_FAILED");
  const saga = new MemoryCorrectionSaga(runtime);
  const action = await saga.prepare({ control_request_id: `${namespace}:dispatch`, candidate_id: candidate.candidate_id,
    provider_instance_id: target.provider_instance_id, targets: [target], scope, content,
    requested_at: now, expires_at: new Date(expires), nonce: `${namespace}:dispatch` });
  approve(action);
  const claim = control.claim(action.request_id, "fixture", now);
  const record = await saga.dispatch(claim);
  return { record, saga, candidate, claim };
}
