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
import { dispatchKey as dispatchKeyFor, externalAnchors, initialized, localKey,
  progressKey as progressKeyFor, tempDb, verifierKey } from "../helpers.js";

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
  readonly incarnation: string; readonly sequence: string; readonly cursor?: string; readonly at: string;
  readonly commit: string; readonly artifact: string; readonly tests: string; readonly evidence: string;
}): RecommendationCompletion {
  const body = { schema_version: 1, source: "recommendation_worker", runtime_id: input.runtime,
    dispatch_receipt_id: input.dispatchReceipt, dispatch_receipt_digest: input.dispatchDigest,
    provider: "codex", worktree_id: input.worktree, terminal_id: input.terminal, session_id: input.session,
    incarnation_id: input.incarnation, pty_id: input.pty, cursor: input.cursor ?? input.sequence, sequence: input.sequence,
    state: "completed", observed_at: input.at, commit_digest: input.commit, artifact_digest: input.artifact,
    test_digest: input.tests, evidence_digest: input.evidence,
    event_id: digest(["recommendation-completion/v1", input.runtime, input.dispatchReceipt,
      input.dispatchDigest, "codex", input.worktree, input.terminal, input.session, input.incarnation, input.pty,
      input.cursor ?? input.sequence, input.sequence, input.at, input.commit, input.artifact, input.tests, input.evidence]),
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
async function dispatchReady(db: AuthorityDb) {
  const dispatchKey = dispatchKeyFor(db); const request = await staged(db);
  const runtime = new RecommendationWorkRuntime(db, () => NOW); const prepared = runtime.prepare(request.request_id);
  const lease = runtime.claim(prepared.runtime_id, "matrix");
  const dispatched = await runtime.dispatch(prepared.runtime_id, lease, { async subscribe() {
    return { event_id: "matrix-dispatch" }; }, async trigger(intent) { return { kind: "accepted",
      receipt: signedDispatch(dispatchKey, intent, { receipt: "matrix-receipt", terminal: "matrix-terminal",
        session: "matrix-session", incarnation: "matrix-incarnation" }) }; } });
  return { runtime, prepared, lease, dispatched };
}
async function verificationReady(db: AuthorityDb) {
  const progress = progressKeyFor(db); const ready = await dispatchReady(db);
  const { runtime, prepared, lease, dispatched } = ready;
  const expected = { commit: digest("matrix-commit"), artifact: digest("matrix-artifact"),
    tests: digest("matrix-tests"), evidence: digest("matrix-evidence") };
  runtime.recordProgress(prepared.runtime_id, lease, signedProgress(progress, { runtime: prepared.runtime_id,
    dispatchReceipt: "matrix-receipt", dispatchDigest: digest(dispatched.receipt), terminal: "matrix-terminal",
    session: "matrix-session", worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation",
    sequence: "1", at: NOW.toISOString(), ...expected }));
  const requestRow = db.db.prepare("SELECT request_digest FROM recommendation_work_verification_requests WHERE runtime_id=?")
    .get(prepared.runtime_id) as { request_digest: string };
  return { ...ready, expected, requestDigest: requestRow.request_digest };
}
function signedVerification(db: AuthorityDb, ready: Awaited<ReturnType<typeof verificationReady>>,
  decision: "PASS" | "REJECT", receiptId: string): RecommendationVerificationReceipt {
  const body = { schema_version: 1, receipt_id: receiptId,
    verification_request_id: ready.prepared.verification_request_id, request_digest: ready.requestDigest,
    runtime_id: ready.prepared.runtime_id, run_id: ready.prepared.run_id,
    workflow_digest: ready.prepared.workflow_digest, dispatch_receipt_id: "matrix-receipt",
    commit_digest: ready.expected.commit, incarnation_id: "matrix-incarnation",
    artifact_digest: ready.expected.artifact, test_digest: ready.expected.tests,
    evidence_digest: ready.expected.evidence, decision, verifier_principal_id: "independent-verifier",
    verifier_session_id: "verifier-session", verifier_incarnation_id: "verifier-incarnation",
    key_id: "verifier-test", algorithm: "Ed25519", issued_at: NOW.toISOString() } as const;
  return { ...body, signature: sign(null, Buffer.concat([
    Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"), Buffer.from(canonicalize(body))]),
    verifierKey(db)).toString("base64url") };
}

describe("Task 26 recommendation work runtime", () => {
  it("bootstraps immutable verifier authority from the configured AuthorityDb anchor", async () => {
    // Given/When: a fresh AuthorityDb is initialized through its configured anchor boundary.
    const db = await initialized();
    try {
      // Then: Task26 verifier authority exists without runtime or raw-SQL provisioning.
      expect(db.db.prepare(`SELECT key_id,principal_id FROM recommendation_work_verifier_bindings`).all())
        .toEqual([{ key_id: "verifier-test", principal_id: "independent-verifier" }]);
    } finally { db.close(); }
  });
  it("reopens duplicate bootstrap authority and rejects a mismatched provider binding", async () => {
    // Given: explicit verifier and provider anchors for one persistent authority DB.
    const anchors = externalAnchors(); const filename = tempDb();
    const options = { decision: { keyId: "decision-bootstrap", principal: "owner-bootstrap",
      publicKeyPath: anchors.decisionPublic }, verifier: { keyId: "verifier-bootstrap",
      principal: "verifier-bootstrap", publicKeyPath: anchors.verifierPublic,
      recommendationWork: { sessionId: "bootstrap-session", incarnationId: "bootstrap-incarnation",
        notBefore: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" } },
      recommendationWork: { dispatch: { keyId: "dispatch-bootstrap", provider: "codex" as const,
        publicKeyPath: anchors.dispatchPublic, notBefore: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z" }, progress: { keyId: "progress-bootstrap",
        provider: "codex" as const, publicKeyPath: anchors.progressPublic, notBefore: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z" } } };
    const first = new AuthorityDb(filename);
    await first.initialize(options); await first.initialize(options); first.close();

    // When: exact anchors reopen, while one changed provider identity attempts to rebind.
    const reopened = new AuthorityDb(filename); await reopened.initialize(options);
    expect(reopened.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verifier_bindings").get())
      .toEqual({ count: 1 });
    expect(reopened.db.prepare("SELECT COUNT(*) count FROM recommendation_work_provider_bindings").get())
      .toEqual({ count: 2 });
    await expect(reopened.initialize({ ...options, recommendationWork: { ...options.recommendationWork,
      dispatch: { ...options.recommendationWork.dispatch, keyId: "changed-dispatch" } } }))
      .rejects.toMatchObject({ code: "RECOMMENDATION_WORK_BOOTSTRAP_MISMATCH" });

    // Then: duplicate/reopen converges and mismatched bootstrap leaves exact rows unchanged.
    expect(reopened.db.prepare("SELECT key_id FROM recommendation_work_provider_bindings ORDER BY purpose").all())
      .toEqual([{ key_id: "dispatch-bootstrap" }, { key_id: "progress-bootstrap" }]);
    reopened.close();
  });

  it("rejects a public PreGjc key that attempts to mint Task26 dispatch authority", async () => {
    // Given: a rogue public legacy key reuses the bootstrapped Task26 dispatch key identifier.
    const db = await initialized(); const rogue = generateKeyPairSync("ed25519");
    try {
      new PreGjcShadow(db).registerKey({ key_id: "worker-dispatch", purpose: "authority-receipt", provider: "codex",
        public_key_pem: rogue.publicKey.export({ type: "spki", format: "pem" }).toString(), active: true,
        not_before: "2026-01-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z" });
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "rogue-probe");

      // When: the adapter presents a correctly shaped receipt signed by only the rogue legacy key.
      const outcome = await runtime.dispatch(prepared.runtime_id, lease, { async subscribe() {
        return { event_id: "rogue-dispatch-event" }; }, async trigger(intent) { return { kind: "accepted",
          receipt: signedDispatch(rogue.privateKey, intent, { receipt: "rogue-receipt", terminal: "rogue-terminal",
            session: "rogue-session", incarnation: "rogue-incarnation" }) }; } });

      // Then: Task26 remains blocked and captures no accepted receipt.
      expect(outcome).toMatchObject({ state: "blocked", receipt: null });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("settles once from exact accepted dispatch, signed progress, and independent verifier PASS", async () => {
    // Given: a Task25 workflow and separately generated implementer-progress and verifier keys.
    const db = await initialized(); const progress = progressKeyFor(db); const dispatchKey = dispatchKeyFor(db);
    try {
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "executor-a");
      const order: string[] = []; const adapter: DispatchAdapter = {
        subscribe: async () => { order.push("subscribe"); return { event_id: "dispatch-event-1" }; },
        trigger: async intent => { order.push("trigger"); return { kind: "accepted", receipt:
          signedDispatch(dispatchKey, intent, { receipt: "dispatch-receipt-1", terminal: "terminal-1",
            session: "session-1", incarnation: "incarnation-1" }) }; },
      };

      // When: dispatch, terminal progress, verification, and settlement are driven through exact events.
      const dispatched = await runtime.dispatch(prepared.runtime_id, lease, adapter);
      expect(order).toEqual(["subscribe", "trigger"]);
      runtime.recordNonterminal(prepared.runtime_id, lease, { event_id: "happy-worker-done", kind: "worker_done" });
      const artifact = digest("artifact"); const tests = digest("tests"); const evidence = digest("evidence");
      const dispatchDigest = digest(dispatched.receipt); const commit = digest("commit");
      const signal = signedProgress(progress, { runtime: prepared.runtime_id,
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
        ["recommendation_work_provider_bindings", "binding_id"],
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
    const retryDispatch = dispatchKeyFor(retryDb); const uncertainDispatch = dispatchKeyFor(uncertainDb);
    try {
      const retryRequest = await staged(retryDb); const retryRuntime = new RecommendationWorkRuntime(retryDb, () => NOW);
      const retryPrepared = retryRuntime.prepare(retryRequest.request_id); const retryLease = retryRuntime.claim(retryPrepared.runtime_id, "retry");
      let retrySends = 0; const retryAdapter: DispatchAdapter = { async subscribe() { return { event_id: `event-${retrySends}` }; },
        async trigger(intent) { retrySends += 1; return retrySends === 1 ? { kind: "not_sent", reason: "fixture_before_send" }
          : { kind: "accepted", receipt: signedDispatch(retryDispatch, intent,
            { receipt: "retry-receipt", terminal: "terminal", session: "session", incarnation: "incarnation" }) }; } };

      // When: a definite no-send is retried, while a separate uncertain send is reconciled.
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
      await retryRuntime.dispatch(retryPrepared.runtime_id, retryLease, retryAdapter);
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
        signedDispatch(uncertainDispatch, uncertainIntent,
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

  it("rejects wrong completion endpoints and enforces exact freshness boundaries", async () => {
    const attacks = [
      ["receipt", { dispatchReceipt: "wrong-receipt" }], ["receipt-digest", { dispatchDigest: digest("wrong") }],
      ["worktree", { worktree: "wrong-worktree" }], ["terminal", { terminal: "wrong-terminal" }],
      ["session", { session: "wrong-session" }], ["incarnation", { incarnation: "wrong-incarnation" }],
      ["pty", { pty: "wrong-pty" }], ["sequence", { sequence: "2" }], ["cursor", { cursor: "wrong-cursor" }],
    ] as const;
    for (const [name, override] of attacks) {
      const db = await initialized();
      try {
        const ready = await dispatchReady(db); const expected = { commit: digest("attack-commit"),
          artifact: digest("attack-artifact"), tests: digest("attack-tests"), evidence: digest("attack-evidence") };
        const input = { runtime: ready.prepared.runtime_id, dispatchReceipt: "matrix-receipt",
          dispatchDigest: digest(ready.dispatched.receipt), terminal: "matrix-terminal", session: "matrix-session",
          worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation", sequence: "1",
          at: NOW.toISOString(), ...expected, ...override };
        expect(() => ready.runtime.recordProgress(ready.prepared.runtime_id, ready.lease,
          signedProgress(progressKeyFor(db), input))).toThrow();
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_progress").get()).toEqual({ count: 0 });
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verification_requests").get())
          .toEqual({ count: 0 });
      } finally { db.close(); }
      void name;
    }
    for (const [offset, accepted] of [[-900_001, false], [-900_000, true], [1, false]] as const) {
      const db = await initialized();
      try {
        const ready = await dispatchReady(db); const input = { runtime: ready.prepared.runtime_id,
          dispatchReceipt: "matrix-receipt", dispatchDigest: digest(ready.dispatched.receipt), terminal: "matrix-terminal",
          session: "matrix-session", worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation",
          sequence: "1", at: new Date(NOW.getTime() + offset).toISOString(), commit: digest("time-commit"),
          artifact: digest("time-artifact"), tests: digest("time-tests"), evidence: digest("time-evidence") };
        const action = () => ready.runtime.recordProgress(ready.prepared.runtime_id, ready.lease,
          signedProgress(progressKeyFor(db), input));
        if (accepted) expect(action).not.toThrow(); else expect(action).toThrow();
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

  it("binds replacement incarnation authority and rejects all prior progress replay", async () => {
    // Given: a verifier-rejected incarnation in bounded recovery.
    const db = await initialized();
    try {
      const ready = await verificationReady(db); const unsigned = { schema_version: 1, receipt_id: "replace-reject",
        verification_request_id: ready.prepared.verification_request_id, request_digest: ready.requestDigest,
        runtime_id: ready.prepared.runtime_id, run_id: ready.prepared.run_id,
        workflow_digest: ready.prepared.workflow_digest, dispatch_receipt_id: "matrix-receipt",
        commit_digest: ready.expected.commit, incarnation_id: "matrix-incarnation",
        artifact_digest: ready.expected.artifact, test_digest: ready.expected.tests,
        evidence_digest: ready.expected.evidence, decision: "REJECT", verifier_principal_id: "independent-verifier",
        verifier_session_id: "verifier-session", verifier_incarnation_id: "verifier-incarnation",
        key_id: "verifier-test", algorithm: "Ed25519", issued_at: NOW.toISOString() } as const;
      ready.runtime.recordVerification(ready.prepared.runtime_id, ready.lease, { ...unsigned, signature: sign(null,
        Buffer.concat([Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"),
          Buffer.from(canonicalize(unsigned))]), verifierKey(db)).toString("base64url") });
      const identity = JSON.parse(String((db.db.prepare("SELECT identity_json FROM recommendation_work_runtimes WHERE runtime_id=?")
        .get(ready.prepared.runtime_id) as { identity_json: string }).identity_json)) as Record<string, unknown>;
      const recovery = 2; const attemptId = `recovery-attempt:${digest({ runtime_id: ready.prepared.runtime_id, recovery }).slice(7)}`;
      const intent: DispatchIntent = { runtime_id: ready.prepared.runtime_id,
        intent_id: ready.prepared.dispatch_intent_id, attempt_id: attemptId, task_id: String(identity["task_id"]),
        run_id: ready.prepared.run_id, workflow_digest: ready.prepared.workflow_digest,
        idempotency_key: String(identity["idempotency_key"]) };

      // When: a separately signed provider receipt installs a distinct replacement incarnation.
      ready.runtime.replaceIncarnation(ready.prepared.runtime_id, ready.lease,
        signedDispatch(dispatchKeyFor(db), intent, { receipt: "replacement-receipt", terminal: "replacement-terminal",
          session: "replacement-session", incarnation: "replacement-incarnation" }));
      const old = signedProgress(progressKeyFor(db), { runtime: ready.prepared.runtime_id,
        dispatchReceipt: "matrix-receipt", dispatchDigest: digest(ready.dispatched.receipt), terminal: "matrix-terminal",
        session: "matrix-session", worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation",
        sequence: "1", at: NOW.toISOString(), ...ready.expected });

      // Then: old signed progress cannot advance or mint another verification request.
      expect(() => ready.runtime.recordProgress(ready.prepared.runtime_id, ready.lease, old))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_PROGRESS_REPLAY_CONFLICT" }));
      expect(db.db.prepare("SELECT current_incarnation_id FROM recommendation_work_runtimes").get())
        .toEqual({ current_incarnation_id: "replacement-incarnation" });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verification_requests").get()).toEqual({ count: 1 });
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

  it("rejects the broad trigger-removed Task25 authority mutation matrix before effects", async () => {
    const changed = `sha256:${"f".repeat(64)}`;
    const cases = [
      ["recommendation", "personal_recommendations", `UPDATE personal_recommendations SET canonical_digest='${changed}'`],
      ["context", "personal_context_snapshots", `UPDATE personal_context_snapshots SET canonical_digest='${changed}'`],
      ["evidence", "personal_recommendation_evidence", `UPDATE personal_recommendation_evidence SET evidence_digest='${changed}'`],
      ["action", "personal_recommendation_actions", "UPDATE personal_recommendation_actions SET title=title||' changed'"],
      ["event", "personal_recommendation_action_events", `UPDATE personal_recommendation_action_events SET evidence_digest='${changed}'`],
      ["request", "control_command_requests", "UPDATE control_command_requests SET nonce='changed-nonce'"],
      ["receipt", "control_command_receipts", "UPDATE control_command_receipts SET signer_principal_id='other-principal'"],
      ["redemption", "control_command_redemptions", "UPDATE control_command_redemptions SET lease_fence=lease_fence+1"],
      ["proposal", "control_command_requests", `UPDATE control_command_requests SET args_json=json_set(args_json,'$.input.proposal.proposal_digest','${changed}')`],
      ["workflow", "workflow_runs", "UPDATE workflow_runs SET input_json=json_set(input_json,'$.recommendation_id','changed')"],
      ["task", "control_command_requests", "UPDATE control_command_requests SET target_json=json_set(target_json,'$.task_id','changed-task')"],
      ["budget", "workflow_runs", "UPDATE workflow_runs SET budget_json=json_set(budget_json,'$.max_steps',99)"],
      ["deadline", "control_command_requests", "UPDATE control_command_requests SET expires_at='2026-08-28T12:20:00.000Z'"],
      ["context-evidence", "personal_context_evidence", "UPDATE personal_context_evidence SET freshness_state='stale'"],
    ] as const;
    for (const [name, table, statement] of cases) {
      // Given: exact Task25 authority followed by one trigger-removed persisted mutation.
      const db = await initialized();
      try {
        const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
        const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, `matrix-${name}`);
        const triggers = db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
          .all(table) as Array<{ name: string }>;
        for (const trigger of triggers) db.db.exec(`DROP TRIGGER "${trigger.name}"`);
        db.db.exec(statement);

        // When/Then: the next mutation reconstructs source authority and writes/effects zero.
        expect(() => runtime.recordNonterminal(prepared.runtime_id, lease,
          { event_id: `mutation-${name}`, kind: "worker_done" })).toThrow();
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_nonterminal_events").get()).toEqual({ count: 0 });
        expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_attempts").get()).toEqual({ count: 0 });
      } finally { db.close(); }
    }
  });

  it("lets subscribed cancellation win before adapter trigger with send zero", async () => {
    // Given: dispatch has entered its exact subscription but has not invoked the adapter trigger.
    const db = await initialized();
    try {
      const request = await staged(db); const runtime = new RecommendationWorkRuntime(db, () => NOW);
      const prepared = runtime.prepare(request.request_id); const lease = runtime.claim(prepared.runtime_id, "subscribe-race");
      const subscribed = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let sends = 0;
      const dispatching = runtime.dispatch(prepared.runtime_id, lease, { async subscribe() { subscribed.resolve();
        await release.promise; return { event_id: "subscribed-cancel" }; }, async trigger() { sends += 1;
        return { kind: "uncertain", reason: "must_not_trigger" }; } });
      await subscribed.promise;

      // When: cancellation commits before subscription releases to the trigger boundary.
      expect(runtime.cancel(prepared.runtime_id, lease, "cancel-before-trigger")).toMatchObject({ state: "cancelled" });
      release.resolve();

      // Then: dispatch converges on cancellation and the adapter is never invoked.
      await expect(dispatching).resolves.toMatchObject({ state: "cancelled", receipt: null });
      expect(sends).toBe(0);
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("persists an in-flight cancel intent and lets dispatch resolve one cancelled terminal outcome", async () => {
    // Given: dispatch is subscribed and paused at the exact injected trigger boundary.
    const db = await initialized(); const dispatchKey = dispatchKeyFor(db);
    try {
      const request = await staged(db);
      const runtime = new RecommendationWorkRuntime(db, () => NOW); const prepared = runtime.prepare(request.request_id);
      const lease = runtime.claim(prepared.runtime_id, "cancel-race"); const entered = Promise.withResolvers<DispatchIntent>();
      const release = Promise.withResolvers<void>(); let sends = 0;
      const dispatching = runtime.dispatch(prepared.runtime_id, lease, { async subscribe() {
        return { event_id: "cancel-race-event" }; }, async trigger(intent) { sends += 1; entered.resolve(intent);
        await release.promise; return { kind: "accepted", receipt: signedDispatch(dispatchKey, intent,
          { receipt: "cancel-race-receipt", terminal: "cancel-terminal", session: "cancel-session",
            incarnation: "cancel-incarnation" }) }; } });
      await entered.promise;

      // When: a second SQLite connection cancels while the adapter invocation is observably in flight.
      const cancellationDb = new AuthorityDb(db.filename); const cancellationRuntime = new RecommendationWorkRuntime(cancellationDb, () => NOW);
      const pending = cancellationRuntime.cancel(prepared.runtime_id, lease, "operator_cancelled");
      expect(pending).toMatchObject({ state: "cancellation_pending", runtime_id: prepared.runtime_id });
      expect(cancellationRuntime.cancel(prepared.runtime_id, lease, "operator_cancelled")).toEqual(pending);
      expect(cancellationRuntime.status(prepared.runtime_id)).toMatchObject({ state: "dispatching",
        cancellation: { state: "pending", reason: "operator_cancelled" } });
      cancellationDb.close(); release.resolve(); const resolved = await dispatching;

      // Then: the observed receipt is captured but cancellation is the sole terminal outcome.
      expect(resolved).toMatchObject({ state: "cancelled" }); expect(sends).toBe(1);
      expect(runtime.status(prepared.runtime_id)).toMatchObject({ state: "cancelled" });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_cancel_requests").get()).toEqual({ count: 1 });
      expect(() => db.db.prepare("UPDATE recommendation_work_cancel_requests SET cancel_id=cancel_id").run()).toThrow();
      expect(() => db.db.prepare("DELETE FROM recommendation_work_cancel_requests").run()).toThrow();
      expect(db.db.prepare("SELECT outcome FROM recommendation_work_settlements").get()).toEqual({ outcome: "cancelled" });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("arbitrates cancellation after dispatch, progress, verify, recover, and settlement", async () => {
    // Dispatch receipt committed: cancellation wins before progress and blocks the signed completion.
    const dispatchedDb = await initialized();
    try {
      const ready = await dispatchReady(dispatchedDb); const cancelled = ready.runtime.cancel(ready.prepared.runtime_id,
        ready.lease, "cancel-after-dispatch"); expect(cancelled).toMatchObject({ state: "cancelled" });
      const expected = { commit: digest("cancel-commit"), artifact: digest("cancel-artifact"),
        tests: digest("cancel-tests"), evidence: digest("cancel-evidence") };
      const completion = signedProgress(progressKeyFor(dispatchedDb), { runtime: ready.prepared.runtime_id,
        dispatchReceipt: "matrix-receipt", dispatchDigest: digest(ready.dispatched.receipt), terminal: "matrix-terminal",
        session: "matrix-session", worktree: "worktree-1", pty: "pty-1", incarnation: "matrix-incarnation",
        sequence: "1", at: NOW.toISOString(), ...expected });
      expect(() => ready.runtime.recordProgress(ready.prepared.runtime_id, ready.lease, completion)).toThrow();
      expect(dispatchedDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_progress").get()).toEqual({ count: 0 });
    } finally { dispatchedDb.close(); }

    // Progress committed: cancellation wins before verifier mutation.
    const progressedDb = await initialized();
    try {
      const ready = await verificationReady(progressedDb); ready.runtime.cancel(ready.prepared.runtime_id,
        ready.lease, "cancel-after-progress");
      expect(() => ready.runtime.recordVerification(ready.prepared.runtime_id, ready.lease,
        signedVerification(progressedDb, ready, "PASS", "post-cancel-pass"))).toThrow();
      expect(progressedDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verification_receipts").get())
        .toEqual({ count: 0 });
    } finally { progressedDb.close(); }

    // Verification committed: cancellation settles once and later settle returns the cancellation winner.
    const verifiedDb = await initialized();
    try {
      const ready = await verificationReady(verifiedDb); ready.runtime.recordVerification(ready.prepared.runtime_id,
        ready.lease, signedVerification(verifiedDb, ready, "PASS", "verified-before-cancel"));
      const cancelled = ready.runtime.cancel(ready.prepared.runtime_id, ready.lease, "cancel-after-verify");
      expect(cancelled).toMatchObject({ state: "cancelled" });
      expect(ready.runtime.settle(ready.prepared.runtime_id, ready.lease)).toEqual(cancelled);
      expect(verifiedDb.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 0 });
    } finally { verifiedDb.close(); }

    // Recovery committed: cancellation wins and no replacement can mutate afterward.
    const recoveryDb = await initialized();
    try {
      const ready = await verificationReady(recoveryDb); ready.runtime.recordVerification(ready.prepared.runtime_id,
        ready.lease, signedVerification(recoveryDb, ready, "REJECT", "reject-before-cancel"));
      expect(ready.runtime.cancel(ready.prepared.runtime_id, ready.lease, "cancel-during-recovery"))
        .toMatchObject({ state: "cancelled" });
      expect(() => ready.runtime.failRecovery(ready.prepared.runtime_id, ready.lease, "late-recovery")).toThrow();
    } finally { recoveryDb.close(); }

    // Settlement committed: completion remains the sole winner and duplicate cancellation returns it.
    const settledDb = await initialized();
    try {
      const ready = await verificationReady(settledDb); ready.runtime.recordVerification(ready.prepared.runtime_id,
        ready.lease, signedVerification(settledDb, ready, "PASS", "pass-before-settle"));
      const completed = ready.runtime.settle(ready.prepared.runtime_id, ready.lease);
      expect(ready.runtime.cancel(ready.prepared.runtime_id, ready.lease, "late-cancel")).toEqual(completed);
      expect(settledDb.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
    } finally { settledDb.close(); }
  });

  it("restarts exactly once after every committed Task26 fault seam", async () => {
    // Given: one bootstrapped runtime and a fault injector for each committed seam.
    const db = await initialized(); const dispatchKey = dispatchKeyFor(db); const progressKey = progressKeyFor(db);
    try {
      const request = await staged(db); const base = new RecommendationWorkRuntime(db, () => NOW);
      const prepared = base.prepare(request.request_id); const lease = base.claim(prepared.runtime_id, "fault-matrix");
      let sends = 0; const adapter: DispatchAdapter = { async subscribe() { return { event_id: `fault-event-${sends}` }; },
        async trigger(intent) { sends += 1; return { kind: "accepted", receipt: signedDispatch(dispatchKey, intent,
          { receipt: "fault-receipt", terminal: "fault-terminal", session: "fault-session",
            incarnation: "fault-incarnation" }) }; } };
      const crashing = (point: "attempt_committed" | "dispatch_committed" | "progress_committed"
        | "verification_committed" | "settlement_committed") => new RecommendationWorkRuntime(db, () => NOW,
          observed => { if (observed === point) throw new TypeError(`fault:${point}`); });

      // When: each post-commit fault is followed by a new runtime instance replaying the exact input.
      await expect(crashing("attempt_committed").dispatch(prepared.runtime_id, lease, adapter)).rejects.toThrow("fault:attempt_committed");
      expect(sends).toBe(0);
      await expect(crashing("dispatch_committed").dispatch(prepared.runtime_id, lease, adapter)).rejects.toThrow("fault:dispatch_committed");
      const dispatched = await base.dispatch(prepared.runtime_id, lease, adapter); expect(sends).toBe(1);
      const expected = { commit: digest("fault-commit"), artifact: digest("fault-artifact"),
        tests: digest("fault-tests"), evidence: digest("fault-evidence") };
      const completed = signedProgress(progressKey, { runtime: prepared.runtime_id, dispatchReceipt: "fault-receipt",
        dispatchDigest: digest(dispatched.receipt), terminal: "fault-terminal", session: "fault-session",
        worktree: "worktree-1", pty: "pty-1", incarnation: "fault-incarnation", sequence: "1",
        at: NOW.toISOString(), ...expected });
      expect(() => crashing("progress_committed").recordProgress(prepared.runtime_id, lease, completed))
        .toThrow("fault:progress_committed");
      base.recordProgress(prepared.runtime_id, lease, completed);
      const requestRow = db.db.prepare("SELECT request_digest FROM recommendation_work_verification_requests WHERE runtime_id=?")
        .get(prepared.runtime_id) as { request_digest: string };
      const unsigned = { schema_version: 1, receipt_id: "fault-verification",
        verification_request_id: prepared.verification_request_id, request_digest: requestRow.request_digest,
        runtime_id: prepared.runtime_id, run_id: prepared.run_id, workflow_digest: prepared.workflow_digest,
        dispatch_receipt_id: "fault-receipt", commit_digest: expected.commit, incarnation_id: "fault-incarnation",
        artifact_digest: expected.artifact, test_digest: expected.tests, evidence_digest: expected.evidence,
        decision: "PASS", verifier_principal_id: "independent-verifier", verifier_session_id: "verifier-session",
        verifier_incarnation_id: "verifier-incarnation", key_id: "verifier-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString() } as const;
      const verified = { ...unsigned, signature: sign(null, Buffer.concat([
        Buffer.from("orca-jarvis/recommendation-verification/v1\0", "ascii"), Buffer.from(canonicalize(unsigned))]),
        verifierKey(db)).toString("base64url") };
      expect(() => crashing("verification_committed").recordVerification(prepared.runtime_id, lease, verified))
        .toThrow("fault:verification_committed");
      base.recordVerification(prepared.runtime_id, lease, verified);
      expect(() => crashing("settlement_committed").settle(prepared.runtime_id, lease)).toThrow("fault:settlement_committed");
      base.settle(prepared.runtime_id, lease);

      // Then: every committed table and external adapter effect remains exactly once.
      expect(sends).toBe(1);
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_dispatch_receipts").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_progress").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_verification_receipts").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_work_settlements").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) count FROM recommendation_verified_outcomes").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("rejects wrong-incarnation progress and lets cancellation win before any send", async () => {
    // Given: one dispatched runtime and one prepared runtime with independent leases.
    const progressDb = await initialized(); const cancelDb = await initialized();
    const key = progressKeyFor(progressDb); const dispatchKey = dispatchKeyFor(progressDb);
    try {
      const progressRequest = await staged(progressDb); const progressRuntime = new RecommendationWorkRuntime(progressDb, () => NOW);
      expect("registerVerifier" in progressRuntime).toBe(false);
      const prepared = progressRuntime.prepare(progressRequest.request_id); const lease = progressRuntime.claim(prepared.runtime_id, "progress");
      const dispatched = await progressRuntime.dispatch(prepared.runtime_id, lease,
        { async subscribe() { return { event_id: "dispatch-event" }; }, async trigger(intent) {
          return { kind: "accepted", receipt: signedDispatch(dispatchKey, intent,
            { receipt: "dispatch-receipt", terminal: "terminal", session: "session", incarnation: "incarnation" }) }; } });

      // When: wrong-incarnation progress arrives and the other runtime is cancelled before dispatch.
      const wrong = signedProgress(key, { runtime: prepared.runtime_id, dispatchReceipt: "dispatch-receipt",
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
