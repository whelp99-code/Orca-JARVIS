import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApprovedCommandExecutor, AuthorityDb, ControlPlane, PreGjcShadow, RecommendationWorkRuntime,
  RecommendationWorkflowStager, Recommendations, RecordingWorkflowStageAdapter,
  DISPATCH_RECEIPT_DOMAIN, signCommandApproval,
  type CommandApprovalReceipt, type DispatchAdapter, type DispatchIntent, type RecommendationCompletion,
  type RecommendationVerificationReceipt,
} from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import { persistTask18Context, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized, localKey, verifierKey } from "../helpers.js";

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
  readonly runtime: string; readonly dispatchReceipt: string; readonly dispatchDigest: string;
  readonly terminal: string; readonly session: string; readonly worktree: string; readonly pty: string;
  readonly incarnation: string; readonly sequence: string; readonly at: string;
  readonly commit: string; readonly artifact: string; readonly tests: string; readonly evidence: string;
}): RecommendationCompletion {
  const body = { schema_version: 1, source: "recommendation_worker", runtime_id: input.runtime,
    dispatch_receipt_id: input.dispatchReceipt, dispatch_receipt_digest: input.dispatchDigest,
    provider: "codex", worktree_id: input.worktree, terminal_id: input.terminal, session_id: input.session,
    incarnation_id: input.incarnation, pty_id: input.pty, cursor: input.sequence, sequence: input.sequence,
    state: "completed", observed_at: input.at, commit_digest: input.commit, artifact_digest: input.artifact,
    test_digest: input.tests, evidence_digest: input.evidence,
    event_id: digest(["recommendation-completion/v1", input.runtime, input.dispatchReceipt,
      input.dispatchDigest, "codex", input.worktree, input.terminal, input.session, input.incarnation, input.pty,
      input.sequence, input.sequence, input.at, input.commit, input.artifact, input.tests, input.evidence]),
    key_id: "worker-progress", algorithm: "Ed25519" } as const;
  return { ...body, signature: sign(null, Buffer.concat([Buffer.from("orca-jarvis/recommendation-completion/v1\0", "ascii"),
    Buffer.from(canonicalize(body), "utf8")]), privateKey).toString("base64url") };
}
function signedDispatch(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], intent: DispatchIntent,
  ids: { readonly receipt: string; readonly terminal: string; readonly session: string; readonly incarnation: string }) {
  const body = { schema_version: 1, receipt_id: ids.receipt, runtime_id: intent.runtime_id,
    intent_id: intent.intent_id, attempt_id: intent.attempt_id, task_id: intent.task_id,
    idempotency_key: intent.idempotency_key, provider: "codex", worktree_id: "worktree-1",
    terminal_id: ids.terminal, session_id: ids.session, incarnation_id: ids.incarnation,
    pty_id: "pty-1", accepted_at: NOW.toISOString(), key_id: "worker-dispatch", algorithm: "Ed25519" } as const;
  return { ...body, signature: sign(null, Buffer.from(DISPATCH_RECEIPT_DOMAIN + canonicalize(body)), privateKey)
    .toString("base64url") };
}
function provision(db: AuthorityDb, progress: ReturnType<typeof generateKeyPairSync>,
  dispatch: ReturnType<typeof generateKeyPairSync>): void {
  const shadow = new PreGjcShadow(db);
  shadow.registerKey({ key_id: "worker-progress", purpose: "progress-signal", provider: "codex",
    public_key_pem: progress.publicKey.export({ type: "spki", format: "pem" }).toString(), active: true,
    not_before: "2026-08-28T12:00:00.000Z", expires_at: "2026-08-28T12:30:00.000Z" });
  shadow.registerKey({ key_id: "worker-dispatch", purpose: "authority-receipt", provider: "codex",
    public_key_pem: dispatch.publicKey.export({ type: "spki", format: "pem" }).toString(), active: true,
    not_before: "2026-08-28T12:00:00.000Z", expires_at: "2026-08-28T12:30:00.000Z" });
}
function provisionVerifier(db: AuthorityDb): void {
  db.db.prepare(`INSERT INTO recommendation_work_verifier_bindings(binding_id,key_id,principal_id,session_id,
    incarnation_id,not_before,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)`).run("task26-verifier-binding",
    "verifier-test", "independent-verifier", "verifier-session", "verifier-incarnation",
    "2026-08-28T12:00:00.000Z", "2026-08-28T12:30:00.000Z", "2026-08-28T12:00:00.000Z");
}
async function verificationReady(db: AuthorityDb) {
  const progress = generateKeyPairSync("ed25519"); const dispatchKey = generateKeyPairSync("ed25519");
  provision(db, progress, dispatchKey); provisionVerifier(db);
  const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
  const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "matrix");
  const dispatched = await runtime.dispatch(prepared.runtime_id, lease, { async subscribe() { return { event_id: "matrix-dispatch" }; },
    async trigger(intent) { return { kind: "accepted", receipt: signedDispatch(dispatchKey.privateKey, intent,
      { receipt: "matrix-receipt", terminal: "matrix-terminal", session: "matrix-session", incarnation: "matrix-incarnation" }) }; } });
  const expected = { commit: digest("matrix-commit"), artifact: digest("matrix-artifact"),
    tests: digest("matrix-tests"), evidence: digest("matrix-evidence") };
  runtime.recordProgress(prepared.runtime_id, lease, signedProgress(progress.privateKey, { runtime: prepared.runtime_id,
    dispatchReceipt: "matrix-receipt", dispatchDigest: digest(dispatched.receipt), terminal: "matrix-terminal",
    session: "matrix-session", worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation",
    sequence: "1", at: NOW.toISOString(), ...expected }));
  const requestRow = db.db.prepare("SELECT request_digest FROM recommendation_work_verification_requests WHERE runtime_id=?")
    .get(prepared.runtime_id) as { request_digest: string };
  return { runtime, prepared, lease, expected, requestDigest: requestRow.request_digest };
}

describe("Task 26 recommendation work runtime", () => {
  it("settles once from exact accepted dispatch, signed progress, and independent verifier PASS", async () => {
    // Given: a Task25 workflow and separately generated implementer-progress and verifier keys.
    const db = await initialized(); const progress = generateKeyPairSync("ed25519");
    const dispatchKey = generateKeyPairSync("ed25519");
    try {
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      provision(db, progress, dispatchKey); provisionVerifier(db);
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "executor-a");
      const order: string[] = []; const adapter: DispatchAdapter = {
        subscribe: async () => { order.push("subscribe"); return { event_id: "dispatch-event-1" }; },
        trigger: async intent => { order.push("trigger"); return { kind: "accepted", receipt:
          signedDispatch(dispatchKey.privateKey, intent, { receipt: "dispatch-receipt-1", terminal: "terminal-1",
            session: "session-1", incarnation: "incarnation-1" }) }; },
      };

      // When: dispatch, terminal progress, verification, and settlement are driven through exact events.
      const dispatched = await runtime.dispatch(prepared.runtime_id, lease, adapter);
      expect(order).toEqual(["subscribe", "trigger"]);
      runtime.recordNonterminal(prepared.runtime_id, lease, { event_id: "happy-worker-done", kind: "worker_done" });
      const artifact = digest("artifact"); const tests = digest("tests"); const evidence = digest("evidence");
      const dispatchDigest = digest(dispatched.receipt); const commit = digest("commit");
      const signal = signedProgress(progress.privateKey, { runtime: prepared.runtime_id,
        dispatchReceipt: "dispatch-receipt-1", dispatchDigest, terminal: "terminal-1", session: "session-1",
        worktree: "worktree-1", pty: "pty-1", incarnation: "incarnation-1", sequence: "1", at: NOW.toISOString(),
        commit, artifact, tests, evidence });
      runtime.recordProgress(prepared.runtime_id, lease, signal);
      const expected = db.db.prepare(`SELECT request_digest,commit_digest,artifact_digest,test_digest,evidence_digest
        FROM recommendation_work_verification_requests WHERE runtime_id=?`).get(prepared.runtime_id);
      expect(expected).toEqual({ request_digest: expect.stringMatching(/^sha256:/), commit_digest: commit,
        artifact_digest: artifact, test_digest: tests, evidence_digest: evidence });
      const unsigned = { schema_version: 1, receipt_id: "verify-receipt-1", verification_request_id:
        dispatched.verification_request_id, runtime_id: prepared.runtime_id, run_id: prepared.run_id,
        workflow_digest: prepared.workflow_digest, dispatch_receipt_id: "dispatch-receipt-1", commit_digest: commit,
        incarnation_id: "incarnation-1", artifact_digest: artifact, test_digest: tests, evidence_digest: evidence,
        request_digest: (expected as { request_digest: string }).request_digest,
        decision: "PASS", verifier_principal_id: "independent-verifier", verifier_session_id: "verifier-session",
        verifier_incarnation_id: "verifier-incarnation", key_id: "verifier-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString() } as const;
      const receipt: RecommendationVerificationReceipt = { ...unsigned, signature: sign(null,
        Buffer.concat([Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"),
          Buffer.from(canonicalize(unsigned), "utf8")]), verifierKey(db)).toString("base64url") };
      runtime.recordVerification(prepared.runtime_id, lease, receipt);
      const first = runtime.settle(prepared.runtime_id, lease); const replay = runtime.settle(prepared.runtime_id, lease);

      // Then: one terminal settlement and one privacy-bounded verified outcome exist.
      expect(first).toEqual(replay); expect(first.state).toBe("completed");
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 1 });
      expect(JSON.stringify(first)).not.toContain("transcript");
      const immutable = [["recommendation_work_verifier_bindings", "binding_id"],
        ["recommendation_work_runtimes", "runtime_id"],
        ["recommendation_work_dispatch_attempts", "attempt_id"], ["recommendation_work_dispatch_receipts", "receipt_id"],
        ["recommendation_work_progress", "event_id"], ["recommendation_work_nonterminal_events", "event_id"],
        ["recommendation_work_verification_requests", "verification_request_id"],
        ["recommendation_work_verification_receipts", "receipt_id"], ["recommendation_work_settlements", "settlement_id"],
        ["recommendation_verified_outcomes", "candidate_id"]] as const;
      for (const [table, key] of immutable) {
        expect(() => db.db.prepare(`UPDATE ${table} SET ${key}=${key}`).run()).toThrow();
        expect(() => db.db.prepare(`DELETE FROM ${table}`).run()).toThrow();
      }
    } finally { db.close(); }
  });

  it("retries only definite not_sent and reconciles uncertainty without a second send", async () => {
    // Given: two fresh Task25 workflows with bounded injected dispatch adapters.
    const retryDb = await initialized(); const uncertainDb = await initialized();
    const retryProgress = generateKeyPairSync("ed25519"); const retryDispatch = generateKeyPairSync("ed25519");
    const uncertainProgress = generateKeyPairSync("ed25519"); const uncertainDispatch = generateKeyPairSync("ed25519");
    try {
      provision(retryDb, retryProgress, retryDispatch);
      const retryRequest = await staged(retryDb); const retryRuntime = new RecommendationWorkRuntime(retryDb, () => NOW);
      const retryPrepared = retryRuntime.prepare(retryRequest.request_id); const retryLease = retryRuntime.claim(retryPrepared.runtime_id, "retry");
      let retrySends = 0; const retryAdapter: DispatchAdapter = { async subscribe() { return { event_id: `event-${retrySends}` }; },
        async trigger(intent) { retrySends += 1; return retrySends === 1 ? { kind: "not_sent", reason: "fixture_before_send" }
          : { kind: "accepted", receipt: signedDispatch(retryDispatch.privateKey, intent,
            { receipt: "retry-receipt", terminal: "terminal", session: "session", incarnation: "incarnation" }) }; } };

      // When: a definite no-send is retried, while a separate uncertain send is reconciled.
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
      provision(uncertainDb, uncertainProgress, uncertainDispatch);
      const uncertainRequest = await staged(uncertainDb); const uncertainRuntime = new RecommendationWorkRuntime(uncertainDb, () => NOW);
      const uncertainPrepared = uncertainRuntime.prepare(uncertainRequest.request_id);
      const uncertainLease = uncertainRuntime.claim(uncertainPrepared.runtime_id, "uncertain"); let uncertainSends = 0;
      let uncertainIntent: DispatchIntent | undefined;
      const uncertainAdapter: DispatchAdapter = { async subscribe() { return { event_id: "uncertain-event" }; },
        async trigger(intent) { uncertainIntent = intent; uncertainSends += 1;
          return { kind: "uncertain", reason: "observable_send_unknown" }; } };
      await uncertainRuntime.dispatch(uncertainPrepared.runtime_id, uncertainLease, uncertainAdapter);
      await expect(uncertainRuntime.dispatch(uncertainPrepared.runtime_id, uncertainLease, uncertainAdapter))
        .rejects.toMatchObject({ code: "RECOMMENDATION_DISPATCH_UNCERTAIN" });
      if (uncertainIntent === undefined) throw new TypeError("uncertain intent required");
      uncertainRuntime.reconcile(uncertainPrepared.runtime_id, uncertainLease,
        signedDispatch(uncertainDispatch.privateKey, uncertainIntent,
          { receipt: "reconciled-receipt", terminal: "terminal", session: "session", incarnation: "incarnation" }));

      // Then: only the definite no-send repeats and uncertainty never invokes the adapter twice.
      expect(retrySends).toBe(2); expect(uncertainSends).toBe(1);
      expect(retryDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
      expect(uncertainDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
      expect(() => uncertainDb.db.prepare("UPDATE recommendation_work_negative_evidence SET evidence_id=evidence_id").run())
        .toThrow();
      expect(() => uncertainDb.db.prepare("DELETE FROM recommendation_work_negative_evidence").run()).toThrow();
    } finally { retryDb.close(); uncertainDb.close(); }
  });

  it("rejects every independently signed expected-evidence mismatch with zero settlement delta", async () => {
    // Given: four independently provisioned runtimes at the exact verification seam.
    for (const field of ["request", "commit", "artifact", "tests", "evidence"] as const) {
      const db = await initialized();
      try {
        const ready = await verificationReady(db); const changed = digest(`wrong-${field}`);
        const unsigned = { schema_version: 1, receipt_id: `mismatch-${field}`,
          verification_request_id: ready.prepared.verification_request_id,
          request_digest: field === "request" ? changed : ready.requestDigest,
          runtime_id: ready.prepared.runtime_id, run_id: ready.prepared.run_id,
          workflow_digest: ready.prepared.workflow_digest, dispatch_receipt_id: "matrix-receipt",
          commit_digest: field === "commit" ? changed : ready.expected.commit,
          incarnation_id: "matrix-incarnation", artifact_digest: field === "artifact" ? changed : ready.expected.artifact,
          test_digest: field === "tests" ? changed : ready.expected.tests,
          evidence_digest: field === "evidence" ? changed : ready.expected.evidence, decision: "PASS",
          verifier_principal_id: "independent-verifier", verifier_session_id: "verifier-session",
          verifier_incarnation_id: "verifier-incarnation", key_id: "verifier-test",
          algorithm: "Ed25519", issued_at: NOW.toISOString() } as const;
        const receipt = { ...unsigned, signature: sign(null, Buffer.concat([
          Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"), Buffer.from(canonicalize(unsigned))]),
          verifierKey(db)).toString("base64url") };

        // When/Then: each signed one-field mismatch fails before any verification or terminal effect.
        expect(() => ready.runtime.recordVerification(ready.prepared.runtime_id, ready.lease, receipt))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_VERIFICATION_BINDING_INVALID" }));
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verification_receipts").get()).toEqual({ count: 0 });
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 0 });
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 0 });
      } finally { db.close(); }
    }
  });

  it("routes verifier REJECT through bounded recovery and one failed settlement", async () => {
    // Given: exact signed completion and an independently signed verifier rejection.
    const db = await initialized();
    try {
      const ready = await verificationReady(db); const unsigned = { schema_version: 1, receipt_id: "matrix-reject",
        verification_request_id: ready.prepared.verification_request_id, request_digest: ready.requestDigest,
        runtime_id: ready.prepared.runtime_id, run_id: ready.prepared.run_id,
        workflow_digest: ready.prepared.workflow_digest, dispatch_receipt_id: "matrix-receipt",
        commit_digest: ready.expected.commit, incarnation_id: "matrix-incarnation",
        artifact_digest: ready.expected.artifact, test_digest: ready.expected.tests,
        evidence_digest: ready.expected.evidence, decision: "REJECT", verifier_principal_id: "independent-verifier",
        verifier_session_id: "verifier-session", verifier_incarnation_id: "verifier-incarnation",
        key_id: "verifier-test", algorithm: "Ed25519", issued_at: NOW.toISOString() } as const;
      const receipt = { ...unsigned, signature: sign(null, Buffer.concat([
        Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"), Buffer.from(canonicalize(unsigned))]),
        verifierKey(db)).toString("base64url") };

      // When: rejection is recorded and the bounded recovery budget is exhausted.
      ready.runtime.recordVerification(ready.prepared.runtime_id, ready.lease, receipt);
      expect(ready.runtime.status(ready.prepared.runtime_id)).toMatchObject({ state: "recovering", recovery_attempts: 1 });
      ready.runtime.failRecovery(ready.prepared.runtime_id, ready.lease, "replacement_unavailable");

      // Then: one failed settlement and negative evidence exist, but no verified outcome does.
      expect(ready.runtime.status(ready.prepared.runtime_id)).toMatchObject({ state: "failed" });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_negative_evidence").get()).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("recomputes Task25 source authority at every mutation seam", async () => {
    // Given: a prepared runtime whose recommendation source is mutated only after removing its immutable trigger.
    const db = await initialized();
    try {
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "source-matrix");
      db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
      db.db.prepare("UPDATE personal_recommendations SET canonical_digest=?").run(`sha256:${"f".repeat(64)}`);

      // When/Then: the next fenced mutation reloads canonical source tables and writes nothing.
      expect(() => runtime.recordNonterminal(prepared.runtime_id, lease,
        { event_id: "source-mutated-event", kind: "worker_done" }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_nonterminal_events").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("rejects wrong-incarnation progress and lets cancellation win before any send", async () => {
    // Given: one dispatched runtime and one prepared runtime with independent leases.
    const progressDb = await initialized(); const cancelDb = await initialized(); const key = generateKeyPairSync("ed25519");
    const dispatchKey = generateKeyPairSync("ed25519");
    try {
      provision(progressDb, key, dispatchKey);
      const progressRequest = await staged(progressDb); const progressRuntime = new RecommendationWorkRuntime(progressDb, () => NOW);
      expect("registerVerifier" in progressRuntime).toBe(false);
      const prepared = progressRuntime.prepare(progressRequest.request_id); const lease = progressRuntime.claim(prepared.runtime_id, "progress");
      const dispatched = await progressRuntime.dispatch(prepared.runtime_id, lease,
        { async subscribe() { return { event_id: "dispatch-event" }; }, async trigger(intent) {
          return { kind: "accepted", receipt: signedDispatch(dispatchKey.privateKey, intent,
            { receipt: "dispatch-receipt", terminal: "terminal", session: "session", incarnation: "incarnation" }) }; } });

      // When: wrong-incarnation progress arrives and the other runtime is cancelled before dispatch.
      const wrong = signedProgress(key.privateKey, { runtime: prepared.runtime_id, dispatchReceipt: "dispatch-receipt",
        dispatchDigest: digest(dispatched.receipt), terminal: "terminal", session: "session", worktree: "worktree-1",
        pty: "pty-1", incarnation: "wrong", sequence: "1", at: NOW.toISOString(), commit: digest("commit"),
        artifact: digest("artifact"), tests: digest("tests"), evidence: digest("evidence") });
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
