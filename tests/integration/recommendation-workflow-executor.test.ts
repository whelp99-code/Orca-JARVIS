import { describe, expect, it } from "vitest";
import {
  ApprovedCommandExecutor,
  AuthorityDb,
  ControlPlane,
  Recommendations,
  RecommendationWorkflowStager,
  RecordingWorkflowStageAdapter,
  signCommandApproval,
  type CommandApprovalReceipt,
  type Sha256Digest,
  type WorkflowRunInput,
  type WorkflowStageAdapter,
} from "../../src/index.js";
import { controlWorkflowRunInput } from "../../src/control-workflow-input.js";
import { workflowInputDigest, type WorkflowStageOutcome } from "../../src/workflow-stage-outcome.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:00.000Z");
const CLAIMED = new Date("2026-08-28T12:10:01.000Z");
const WORKER = "recommendation-workflow-primary";
function isDigest(value: unknown): value is Sha256Digest { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }

function request(): unknown {
  return { schema_version: 1, recommendation_id: RECOMMENDATION_ID, action_rank: 1,
    requested_by: { principal_id: "test-operator", authenticated_session_id: "session:owner" },
    target: { repository: "Orca-JARVIS", environment: "local" },
    workflow: { goal: "Implement the bounded recommended action", args: { branch: "task25" } },
    budget: { max_steps: 6, max_attempts_per_node: 2 }, deadline: "2026-08-28T12:45:00.000Z" };
}
function seed(db: AuthorityDb): {
  readonly staged: ReturnType<RecommendationWorkflowStager["stage"]>;
  readonly recommendationId: ReturnType<Recommendations["create"]>["recommendation"]["id"];
} {
  const context = persistTask18Context(db); const created = new Recommendations(db).create(task18Request(context));
  return { staged: new RecommendationWorkflowStager(db, () => NOW).stage(request()), recommendationId: created.recommendation.id };
}
function approve(db: AuthorityDb, staged: ReturnType<RecommendationWorkflowStager["stage"]>,
  overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}): void {
  const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `receipt:${staged.request_id}`,
    request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "test-operator", authenticated_session_id: "session:owner", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: CLAIMED.toISOString(), not_before: CLAIMED.toISOString(), expires_at: staged.expires_at,
    nonce: `receipt-nonce:${staged.request_id}`, max_uses: 1, status: "issued", ...overrides };
  new ControlPlane(db).decide(signCommandApproval(payload, localKey(db)), CLAIMED);
}
class Recorder implements WorkflowStageAdapter {
  readonly calls: WorkflowRunInput[] = [];
  async stage(input: WorkflowRunInput, now: Date): Promise<WorkflowStageOutcome> {
    void now; this.calls.push(input);
    return { kind: "staged", run_id: input.run_id, workflow_digest: workflowInputDigest(input) };
  }
}
class PersistentRecorder extends Recorder {
  private readonly delegate: RecordingWorkflowStageAdapter;
  constructor(db: AuthorityDb) { super(); this.delegate = new RecordingWorkflowStageAdapter(db); }
  override async stage(input: WorkflowRunInput, now: Date): Promise<WorkflowStageOutcome> {
    await super.stage(input, now); return this.delegate.stage(input, now);
  }
}

describe("Task 25 approved workflow stage executor", () => {
  it("claims before one injected stage and converges on replay", async () => {
    // Given: a pending recommendation workflow request and a recording adapter.
    const db = await initialized();
    try {
      const { staged } = seed(db); const recorder = new PersistentRecorder(db); const executor = new ApprovedCommandExecutor(db);
      await expect(executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED }))
        .rejects.toMatchObject({ code: "CONTROL_APPROVAL_REQUIRED" });
      await expect(new RecordingWorkflowStageAdapter(db).stage(controlWorkflowRunInput(staged.args), CLAIMED))
        .rejects.toMatchObject({ code: "RECOMMENDATION_WORKFLOW_RECORDING_AUTHORITY_REQUIRED" });
      expect(recorder.calls).toHaveLength(0);
      approve(db, staged);

      // When: the approved request and its restart replay are executed.
      const first = await executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED });
      const replay = await executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED });

      // Then: one claim, adapter invocation, and settled workflow-stage effect exist.
      expect(first).toEqual(replay);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]).toEqual(expect.objectContaining({ loop_id: "agentops-default", correlation_id: RECOMMENDATION_ID }));
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("resumes a crash after claim and refuses a concurrent primary executor", async () => {
    // Given: an approved command already claimed by the fixed primary worker.
    const db = await initialized();
    try {
      const { staged } = seed(db); approve(db, staged); new ControlPlane(db).claim(staged.request_id, WORKER, CLAIMED);
      const recorder = new Recorder(); const executor = new ApprovedCommandExecutor(db);

      // When: the executor restarts after that claim.
      await executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED });

      // Then: it stages exactly once and a conflicting worker cannot stage.
      expect(recorder.calls).toHaveLength(1);
      await expect(executor.executeWorkflowStage({ requestId: staged.request_id, worker: "other-primary", adapter: recorder, now: CLAIMED }))
        .rejects.toMatchObject({ code: "RECOMMENDATION_WORKFLOW_EXECUTOR_CONFLICT" });
      expect(recorder.calls).toHaveLength(1);
    } finally { db.close(); }
  });

  it("rejects a wrong-session receipt before claim and detects changed lifecycle", async () => {
    // Given: one staged request approved under a session other than the bound authenticated session.
    const wrongDb = await initialized();
    try {
      const { staged } = seed(wrongDb); approve(wrongDb, staged, { authenticated_session_id: "session:other" });

      // When/Then: receipt binding fails before redemption or adapter invocation.
      const recorder = new Recorder();
      await expect(new ApprovedCommandExecutor(wrongDb).executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED }))
        .rejects.toMatchObject({ code: "RECOMMENDATION_WORKFLOW_RECEIPT_MISMATCH" });
      expect(recorder.calls).toHaveLength(0);
      expect(wrongDb.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get()).toEqual({ count: 0 });
    } finally { wrongDb.close(); }

    const changedDb = await initialized();
    try {
      const { staged, recommendationId } = seed(changedDb); approve(changedDb, staged);
      const evidence = changedDb.getPersonalRecommendation(recommendationId)?.recommendation["evidence_digest"];
      if (!isDigest(evidence)) throw new TypeError("evidence digest required");
      changedDb.transitionRecommendationAction({ recommendation_id: recommendationId, rank: 1, state: "accepted",
        evidence_digest: evidence, occurred_at: "2026-08-28T12:10:00.500Z" });
      const recorder = new Recorder();
      await expect(new ApprovedCommandExecutor(changedDb).executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED }))
        .rejects.toMatchObject({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" });
      expect(recorder.calls).toHaveLength(0);
      expect(changedDb.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get()).toEqual({ count: 0 });
    } finally { changedDb.close(); }
  });

  it("allows one of two connections to cross the exact concurrent claim boundary", async () => {
    // Given: two executors on separate SQLite connections and an adapter paused at the exact stage event.
    const firstDb = await initialized();
    const secondDb = new AuthorityDb(firstDb.filename);
    try {
      const { staged } = seed(firstDb); approve(firstDb, staged); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const recorder: WorkflowStageAdapter = { async stage(input) {
        entered.resolve(); await release.promise;
        return { kind: "staged", run_id: input.run_id, workflow_digest: workflowInputDigest(input) };
      } };
      const first = new ApprovedCommandExecutor(firstDb).executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED });
      await entered.promise;

      // When: the second connection attempts the same active primary execution.
      const second = new ApprovedCommandExecutor(secondDb).executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter: recorder, now: CLAIMED });

      // Then: it fails closed while the first settles exactly once.
      await expect(second).rejects.toMatchObject({ code: "RECOMMENDATION_WORKFLOW_EXECUTOR_CONFLICT" });
      release.resolve(); await expect(first).resolves.toMatchObject({ state: "completed" });
      expect(firstDb.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get()).toEqual({ count: 1 });
      expect(firstDb.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects").get()).toEqual({ count: 1 });
    } finally { secondDb.close(); firstDb.close(); }
  });

  it("uses the exact receipt expiry boundary at plus or minus one millisecond", async () => {
    // Given: two equivalent approvals observed immediately before and exactly at receipt expiry.
    const beforeDb = await initialized(); const exactDb = await initialized();
    try {
      const beforeSeed = seed(beforeDb); const exactSeed = seed(exactDb);
      approve(beforeDb, beforeSeed.staged); approve(exactDb, exactSeed.staged);
      const before = new Date(Date.parse(beforeSeed.staged.expires_at) - 1);
      const exact = new Date(exactSeed.staged.expires_at);

      // When/Then: one millisecond before can claim, while exact expiry cannot claim or stage.
      await expect(new ApprovedCommandExecutor(beforeDb).executeWorkflowStage({
        requestId: beforeSeed.staged.request_id, worker: WORKER, adapter: new Recorder(), now: before,
      })).resolves.toMatchObject({ state: "completed" });
      const recorder = new Recorder();
      await expect(new ApprovedCommandExecutor(exactDb).executeWorkflowStage({
        requestId: exactSeed.staged.request_id, worker: WORKER, adapter: recorder, now: exact,
      })).rejects.toMatchObject({ code: "CONTROL_APPROVAL_REQUIRED" });
      expect(recorder.calls).toHaveLength(0);
      expect(exactDb.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get()).toEqual({ count: 0 });
    } finally { beforeDb.close(); exactDb.close(); }
  });

  it("preserves a resolved uncertain stage outcome without false completion", async () => {
    // Given: an approved request whose adapter resolves an explicit uncertain outcome.
    const db = await initialized();
    try {
      const { staged } = seed(db); approve(db, staged); let calls = 0;
      const evidence = `sha256:${"a".repeat(64)}`;
      const adapter: WorkflowStageAdapter = {
        async stage() { calls += 1; return { kind: "uncertain", reason: "stage_boundary_uncertain", evidence_digest: evidence }; },
      };
      const executor = new ApprovedCommandExecutor(db);

      // When: the approved executor parses the resolved outcome.
      const result = await executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter, now: CLAIMED });

      // Then: uncertainty is durable, no completed workflow/effect exists, and replay never invokes again.
      expect(result).toMatchObject({ state: "uncertain", result: { kind: "uncertain", evidence_digest: evidence } });
      expect(db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(staged.request_id))
        .toEqual({ state: "uncertain" });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects WHERE effect_type='recommendation.workflow.staged'").get())
        .toEqual({ count: 0 });
      await expect(executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter, now: CLAIMED }))
        .rejects.toMatchObject({ code: "CONTROL_APPROVAL_REQUIRED" });
      expect(calls).toBe(1);
    } finally { db.close(); }
  });

  it("maps an unknown resolved adapter result to typed durable uncertainty", async () => {
    // Given: an approved request and a runtime adapter violating its declared outcome contract.
    const db = await initialized();
    try {
      const { staged } = seed(db); approve(db, staged); let calls = 0;
      const adapter: WorkflowStageAdapter = {
        async stage(): Promise<WorkflowStageOutcome> { calls += 1; return JSON.parse('{"kind":"mystery"}'); },
      };

      // When: the executor parses the unknown result.
      const result = await new ApprovedCommandExecutor(db).executeWorkflowStage({
        requestId: staged.request_id, worker: WORKER, adapter, now: CLAIMED,
      });

      // Then: it settles typed uncertainty and cannot invoke the adapter again.
      expect(result).toMatchObject({
        state: "uncertain", result: { kind: "uncertain", reason: "invalid_outcome" },
      });
      expect(calls).toBe(1);
      expect(db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(staged.request_id))
        .toEqual({ state: "uncertain" });
    } finally { db.close(); }
  });

  it("settles an adapter throw as uncertain and never retries the boundary", async () => {
    // Given: an approved request and an adapter whose stage boundary throws.
    const db = await initialized();
    try {
      const { staged } = seed(db); approve(db, staged); let calls = 0;
      const adapter: WorkflowStageAdapter = { async stage() { calls += 1; throw new TypeError("stage outcome unknown"); } };
      const executor = new ApprovedCommandExecutor(db);

      // When: execution crosses the uncertain adapter boundary.
      const result = await executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter, now: CLAIMED });

      // Then: the claim is consumed, uncertainty is durable, and replay cannot invoke again.
      expect(result).toMatchObject({ state: "uncertain", failure_code: "RECOMMENDATION_WORKFLOW_STAGE_UNCERTAIN" });
      await expect(executor.executeWorkflowStage({ requestId: staged.request_id, worker: WORKER, adapter, now: CLAIMED }))
        .rejects.toMatchObject({ code: "CONTROL_APPROVAL_REQUIRED" });
      expect(calls).toBe(1);
      expect(db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(staged.request_id)).toEqual({ state: "uncertain" });
    } finally { db.close(); }
  });
});
