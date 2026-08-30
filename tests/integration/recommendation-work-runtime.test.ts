import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApprovedCommandExecutor, AuthorityDb, ControlPlane, RecommendationWorkRuntime,
  RecommendationWorkflowStager, Recommendations, RecordingWorkflowStageAdapter,
  signCommandApproval,
  type CommandApprovalReceipt, type DispatchAdapter, type ProgressSignal,
  type RecommendationVerificationReceipt,
} from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import { persistTask18Context, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:01.000Z");
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

async function staged(db: AuthorityDb) {
  const context = persistTask18Context(db); const recommendation = new Recommendations(db).create(task18Request(context));
  const request = new RecommendationWorkflowStager(db, () => new Date(NOW.getTime() - 1_000)).stage({
    schema_version: 1, recommendation_id: recommendation.recommendation.id, action_rank: 1,
    requested_by: { principal_id: "test-operator", authenticated_session_id: "session:owner" },
    target: { repository: "Orca-JARVIS", environment: "local" },
    workflow: { goal: "Implement bounded work", args: { branch: "task26" } },
    budget: { max_steps: 6, max_attempts_per_node: 2 }, deadline: "2026-08-28T12:45:00.000Z",
  });
  const payload: Omit<CommandApprovalReceipt, "signature"> = {
    schema_version: 1, receipt_id: `receipt:${request.request_id}`, request_id: request.request_id,
    decision: "approve", command_digest: request.command_digest, signer_principal_id: "test-operator",
    authenticated_session_id: "session:owner", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: request.expires_at,
    nonce: `nonce:${request.request_id}`, max_uses: 1, status: "issued",
  };
  new ControlPlane(db).decide(signCommandApproval(payload, localKey(db)), NOW);
  await new ApprovedCommandExecutor(db).executeWorkflowStage({ requestId: request.request_id,
    worker: "task25-primary", adapter: new RecordingWorkflowStageAdapter(db), now: NOW });
  return request;
}

function signedProgress(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], input: {
  readonly terminal: string; readonly incarnation: string; readonly sequence: string; readonly at: string;
}): ProgressSignal {
  const body = { schema_version: 1, source: "provider_bridge", provider: "codex", terminal_id: input.terminal,
    incarnation_id: input.incarnation, cursor: input.sequence, sequence: input.sequence, state: "stopped",
    reason_code: "jarvis_canonical_final_stopped", active: true, observed_at: input.at,
    event_id: digest(["progress-signal-event/v1", "provider_bridge", "codex", input.terminal,
      input.incarnation, input.sequence, input.sequence, "stopped", "jarvis_canonical_final_stopped", true, input.at]),
    key_id: "worker-progress", algorithm: "Ed25519" } as const;
  return { ...body, signature: sign(null, Buffer.concat([Buffer.from("orca-jarvis/progress-signal/v1\0", "ascii"),
    Buffer.from(canonicalize(body), "utf8")]), privateKey).toString("base64url") };
}

describe("Task 26 recommendation work runtime", () => {
  it("settles once from exact accepted dispatch, signed progress, and independent verifier PASS", async () => {
    // Given: a Task25 workflow and separately generated implementer-progress and verifier keys.
    const db = await initialized(); const progress = generateKeyPairSync("ed25519"); const verifier = generateKeyPairSync("ed25519");
    try {
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      runtime.registerProgressKey({ key_id: "worker-progress", provider: "codex", public_key_pem:
        progress.publicKey.export({ type: "spki", format: "pem" }).toString(), not_before: "2026-08-28T12:00:00.000Z",
        expires_at: "2026-08-28T12:30:00.000Z" });
      runtime.registerVerifier({ key_id: "task26-verifier", principal_id: "independent-task26-verifier",
        public_key_pem: verifier.publicKey.export({ type: "spki", format: "pem" }).toString() });
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "executor-a");
      const order: string[] = []; const adapter: DispatchAdapter = {
        subscribe: async () => { order.push("subscribe"); return { event_id: "dispatch-event-1" }; },
        trigger: async intent => { order.push("trigger"); return { kind: "accepted", receipt: {
          receipt_id: "dispatch-receipt-1", intent_id: intent.intent_id, task_id: intent.task_id,
          provider: "codex", worktree_id: "worktree-1", terminal_id: "terminal-1", session_id: "session-1",
          incarnation_id: "incarnation-1", pty_id: "pty-1", accepted_at: NOW.toISOString(),
        } }; },
      };

      // When: dispatch, terminal progress, verification, and settlement are driven through exact events.
      const dispatched = await runtime.dispatch(prepared.runtime_id, lease, adapter);
      expect(order).toEqual(["subscribe", "trigger"]);
      const signal = signedProgress(progress.privateKey, { terminal: "terminal-1", incarnation: "incarnation-1",
        sequence: "1", at: NOW.toISOString() });
      runtime.recordProgress(prepared.runtime_id, lease, signal);
      const artifact = digest("artifact"); const tests = digest("tests"); const evidence = digest("evidence");
      const unsigned = { schema_version: 1, receipt_id: "verify-receipt-1", verification_request_id:
        dispatched.verification_request_id, runtime_id: prepared.runtime_id, run_id: prepared.run_id,
        workflow_digest: prepared.workflow_digest, dispatch_receipt_id: "dispatch-receipt-1", commit_digest: digest("commit"),
        incarnation_id: "incarnation-1", artifact_digest: artifact, test_digest: tests, evidence_digest: evidence,
        decision: "PASS", verifier_principal_id: "independent-task26-verifier", verifier_session_id: "verifier-session-1",
        verifier_incarnation_id: "verifier-incarnation-1", key_id: "task26-verifier", algorithm: "Ed25519",
        issued_at: NOW.toISOString() } as const;
      const receipt: RecommendationVerificationReceipt = { ...unsigned, signature: sign(null,
        Buffer.concat([Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"),
          Buffer.from(canonicalize(unsigned), "utf8")]), verifier.privateKey).toString("base64url") };
      runtime.recordVerification(prepared.runtime_id, lease, receipt);
      const first = runtime.settle(prepared.runtime_id, lease); const replay = runtime.settle(prepared.runtime_id, lease);

      // Then: one terminal settlement and one privacy-bounded verified outcome exist.
      expect(first).toEqual(replay); expect(first.state).toBe("completed");
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 1 });
      expect(JSON.stringify(first)).not.toContain("transcript");
    } finally { db.close(); }
  });

  it("retries only definite not_sent and reconciles uncertainty without a second send", async () => {
    // Given: two fresh Task25 workflows with bounded injected dispatch adapters.
    const retryDb = await initialized(); const uncertainDb = await initialized();
    try {
      const retryRequest = await staged(retryDb); const retryRuntime = new RecommendationWorkRuntime(retryDb, () => NOW);
      const retryPrepared = retryRuntime.prepare(retryRequest.request_id); const retryLease = retryRuntime.claim(retryPrepared.runtime_id, "retry");
      let retrySends = 0; const retryAdapter: DispatchAdapter = { async subscribe() { return { event_id: `event-${retrySends}` }; },
        async trigger(intent) { retrySends += 1; return retrySends === 1 ? { kind: "not_sent", reason: "fixture_before_send" }
          : { kind: "accepted", receipt: { receipt_id: "retry-receipt", intent_id: intent.intent_id, task_id: intent.task_id,
            provider: "codex", worktree_id: "worktree", terminal_id: "terminal", session_id: "session",
            incarnation_id: "incarnation", pty_id: "pty", accepted_at: NOW.toISOString() } }; } };

      // When: a definite no-send is retried, while a separate uncertain send is reconciled.
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
      const uncertainRequest = await staged(uncertainDb); const uncertainRuntime = new RecommendationWorkRuntime(uncertainDb, () => NOW);
      const uncertainPrepared = uncertainRuntime.prepare(uncertainRequest.request_id);
      const uncertainLease = uncertainRuntime.claim(uncertainPrepared.runtime_id, "uncertain"); let uncertainSends = 0;
      const uncertainAdapter: DispatchAdapter = { async subscribe() { return { event_id: "uncertain-event" }; },
        async trigger() { uncertainSends += 1; return { kind: "uncertain", reason: "observable_send_unknown" }; } };
      await uncertainRuntime.dispatch(uncertainPrepared.runtime_id, uncertainLease, uncertainAdapter);
      await expect(uncertainRuntime.dispatch(uncertainPrepared.runtime_id, uncertainLease, uncertainAdapter))
        .rejects.toMatchObject({ code: "RECOMMENDATION_DISPATCH_UNCERTAIN" });
      const task = uncertainDb.db.prepare("SELECT json_extract(target_json,'$.task_id') task_id FROM control_command_requests WHERE request_id=?")
        .get(uncertainRequest.request_id) as { task_id: string };
      uncertainRuntime.reconcile(uncertainPrepared.runtime_id, uncertainLease, { receipt_id: "reconciled-receipt",
        intent_id: uncertainPrepared.dispatch_intent_id, task_id: task.task_id,
        provider: "codex", worktree_id: "worktree", terminal_id: "terminal",
        session_id: "session", incarnation_id: "incarnation", pty_id: "pty", accepted_at: NOW.toISOString() });

      // Then: only the definite no-send repeats and uncertainty never invokes the adapter twice.
      expect(retrySends).toBe(2); expect(uncertainSends).toBe(1);
      expect(retryDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
      expect(uncertainDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
    } finally { retryDb.close(); uncertainDb.close(); }
  });

  it("rejects wrong-incarnation progress and lets cancellation win before any send", async () => {
    // Given: one dispatched runtime and one prepared runtime with independent leases.
    const progressDb = await initialized(); const cancelDb = await initialized(); const key = generateKeyPairSync("ed25519");
    try {
      const progressRequest = await staged(progressDb); const progressRuntime = new RecommendationWorkRuntime(progressDb, () => NOW);
      progressRuntime.registerProgressKey({ key_id: "worker-progress", provider: "codex", public_key_pem:
        key.publicKey.export({ type: "spki", format: "pem" }).toString(), not_before: "2026-08-28T12:00:00.000Z",
        expires_at: "2026-08-28T12:30:00.000Z" });
      const prepared = progressRuntime.prepare(progressRequest.request_id); const lease = progressRuntime.claim(prepared.runtime_id, "progress");
      await progressRuntime.dispatch(prepared.runtime_id, lease, { async subscribe() { return { event_id: "dispatch-event" }; },
        async trigger(intent) { return { kind: "accepted", receipt: { receipt_id: "dispatch-receipt", intent_id: intent.intent_id,
          task_id: intent.task_id, provider: "codex", worktree_id: "worktree", terminal_id: "terminal",
          session_id: "session", incarnation_id: "incarnation", pty_id: "pty", accepted_at: NOW.toISOString() } }; } });

      // When: wrong-incarnation progress arrives and the other runtime is cancelled before dispatch.
      const wrong = signedProgress(key.privateKey, { terminal: "terminal", incarnation: "wrong", sequence: "1", at: NOW.toISOString() });
      expect(() => progressRuntime.recordProgress(prepared.runtime_id, lease, wrong))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_PROGRESS_INVALID" }));
      const cancelRequest = await staged(cancelDb); const cancelRuntime = new RecommendationWorkRuntime(cancelDb, () => NOW);
      const cancelPrepared = cancelRuntime.prepare(cancelRequest.request_id); const cancelLease = cancelRuntime.claim(cancelPrepared.runtime_id, "cancel");
      const cancelled = cancelRuntime.cancel(cancelPrepared.runtime_id, cancelLease, "operator_cancelled"); let sends = 0;
      await expect(cancelRuntime.dispatch(cancelPrepared.runtime_id, cancelLease, { async subscribe() { return { event_id: "never" }; },
        async trigger() { sends += 1; return { kind: "uncertain", reason: "forbidden" }; } }))
        .rejects.toMatchObject({ code: "RECOMMENDATION_WORK_TERMINAL" });

      // Then: neither invalid progress nor post-cancel dispatch creates an effect.
      expect(cancelRuntime.cancel(cancelPrepared.runtime_id, cancelLease, "operator_cancelled")).toEqual(cancelled);
      expect(progressDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_progress").get()).toEqual({ count: 0 });
      expect(cancelDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_attempts").get()).toEqual({ count: 0 });
      expect(sends).toBe(0);
    } finally { progressDb.close(); cancelDb.close(); }
  });
});
