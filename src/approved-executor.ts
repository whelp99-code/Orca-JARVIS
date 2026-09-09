import { resolve } from "node:path";
import { executeApprovedMemoryCommand } from "./approved-memory-execution.js";
import { executeApprovedTaskRequest } from "./approved-task-execution.js";
import type { TaskExecutionRuntime } from "./task-execution-runtime.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { validateControlAction } from "./control-actions.js";
import { ControlEffectAttempts, type ExternalEffectContext } from "./control-effect-attempts.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { controlWorkflowAdvanceInput, controlWorkflowRunInput } from "./control-workflow-input.js";
import { writeCurrentState } from "./state-projection.js";
import { LoopGraph, type LoopSpec } from "./loopgraph.js";
import { RunbookEngine, isUncertainRunbookError, type HostOperations } from "./runbook.js";
import { appendSettledNegativeEvidence } from "./negative-evidence.js";
import { executeApprovedWorkflowStage, type ExecuteWorkflowStageInput } from "./approved-workflow-stage.js";
import type { ApprovedExecutionResult } from "./approved-executor-types.js";
import type { MemoryOutboxService } from "./memory-outbox.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service-types.js";
import { confirmMemoryCorrectionCandidate } from "./memory-correction-saga.js";
import { completeMemoryRememberDecision } from "./memory-remember-confirmation.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";
import { copyPinnedRegularFile, privatePath, publishFile, removeSqliteCopy, secureBasename, secureRoot } from "./secure-filesystem.js";

export type { ApprovedExecutionResult } from "./approved-executor-types.js";
export type { MemoryLifecycleService } from "./memory-lifecycle-service-types.js";

export class ApprovedCommandExecutor {
  private readonly control: ControlPlane;
  private readonly effects: ControlEffectAttempts;
  constructor(
    private readonly authority: AuthorityDb,
    private readonly backupRoot = resolve(".jarvis-backups"),
    private readonly stateRoot = resolve("state"),
    private readonly hostOperations: HostOperations = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly memoryOutbox?: MemoryOutboxService,
    private readonly memoryEffects?: SecondBrainEffectService,
    private readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">,
    private readonly taskRuntime?: TaskExecutionRuntime,
  ) {
    this.control = new ControlPlane(authority);
    this.effects = new ControlEffectAttempts(authority);
  }

  private async run(
    command: ClaimedControlCommand,
    now: Date,
    externalContext: ExternalEffectContext | undefined,
    worker: string,
  ): Promise<{ effect_type: string; payload: unknown }> {
    const action = validateControlAction(command, { enforceMinimumLevel: true, levelErrorCode: "APPROVED_ACTION_LEVEL_TOO_LOW" });
    if (!action.executable) throw new JarvisError("APPROVED_ACTION_UNKNOWN");
    if (command.action === "database.backup") {
      const root = await secureRoot(this.backupRoot);
      const basename = secureBasename(command.args.destination ?? `${command.request_id}.sqlite`);
      const temporary = privatePath(root, "backup.sqlite");
      try {
        const metadata = await this.authority.db.backup(temporary);
        const destination = await publishFile(root, temporary, basename);
        return {
          effect_type: "database.backup",
          payload: {
            destination, total_pages: metadata.totalPages, remaining_pages: metadata.remainingPages,
          },
        };
      } catch (error) {
        await removeSqliteCopy(temporary);
        throw error;
      }
    }
    if (command.action === "database.restore_drill") {
      const root = await secureRoot(this.backupRoot);
      const source = secureBasename(command.args.source);
      const privateCopy = await copyPinnedRegularFile(root, source, "restore.sqlite");
      const restored = new AuthorityDb(privateCopy);
      try {
        await restored.assertMigrationsReady();
        const quick = String((restored.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check);
        if (quick !== "ok") throw new JarvisError("RESTORE_DRILL_INTEGRITY_FAILED");
        return { effect_type: "database.restore_drill", payload: { source, quick_check: quick, migrations_ready: true } };
      } finally {
        restored.close();
        await removeSqliteCopy(privateCopy);
      }
    }
    if (command.action === "state.project") {
      const output = await writeCurrentState(
        this.authority, this.stateRoot, now, { exclude_control_request_id: command.request_id },
      );
      return {
        effect_type: "state.projection",
        payload: {
          generation: output.generation, directory: output.directory,
          json: output.json, markdown: output.markdown,
          generated_at: output.projection.generated_at,
        },
      };
    }
    const graph = new LoopGraph(this.authority);
    if (command.action === "workflow.register") {
      const spec = command.args.spec as LoopSpec;
      return {
        effect_type: "workflow.definition",
        payload: { spec_digest: graph.register(spec, now), loop_id: spec.loop_id },
      };
    }
    if (command.action === "workflow.start") {
      if (command.args.loop_id === "agentops-default" && worker === "dashboard-approved-executor") graph.ensureDefaults(now);
      const run = graph.start(controlWorkflowRunInput(command.args), now);
      return { effect_type: "workflow.started", payload: run };
    }
    if (command.action === "workflow.advance") {
      const run = graph.advance({
        ...controlWorkflowAdvanceInput(command.args),
        approval_receipt_id: command.receipt_id,
      }, now);
      return { effect_type: "workflow.advanced", payload: run };
    }
    if (command.action === "workflow.cancel") {
      const runId = command.args.run_id; const reason = command.args.reason;
      if (typeof runId !== "string" || typeof reason !== "string") {
        throw new JarvisError("WORKFLOW_CANCEL_INVALID");
      }
      return { effect_type: "workflow.cancelled", payload: graph.cancel(runId, reason, now) };
    }
    if (command.action === "runbook.execute") {
      const runbookId = command.args.runbook_id; const args = command.args.args;
      if (typeof runbookId !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        throw new JarvisError("RUNBOOK_INPUT_INVALID");
      }
      const engine = new RunbookEngine(this.authority, this.hostOperations);
      const result = await engine.execute(
        command.request_id, command.action_level, runbookId,
        args as Record<string, unknown>, now, externalContext,
      );
      return { effect_type: "runbook.execution", payload: result };
    }
    throw new JarvisError("APPROVED_ACTION_UNKNOWN");
  }

  executeWorkflowStage(input: ExecuteWorkflowStageInput): Promise<ApprovedExecutionResult> {
    return executeApprovedWorkflowStage({ authority: this.authority, control: this.control, input });
  }

  async execute(requestId: string, worker = "approved-command-executor", now = this.clock()): Promise<ApprovedExecutionResult> {
    const route = this.authority.db.prepare("SELECT action FROM control_command_requests WHERE request_id=?")
      .get(requestId) as { action: string } | undefined;
    if (route?.action === "task.execute") return executeApprovedTaskRequest({
      authority: this.authority, request_id: requestId, worker, clock: this.clock, runtime: this.taskRuntime });
    const command = this.control.claim(requestId, worker, now);
    const externalRunbook = command.action === "runbook.execute"
      && command.args.runbook_id === "daemon-dead"
      && command.action_level >= 3
      && Boolean(this.hostOperations.restartService);
    let externalContext: ExternalEffectContext | undefined;
    try {
      if (externalRunbook) {
        externalContext = this.effects.prepare(command, "service.restart", now);
        this.effects.update(requestId, "invoking", now);
      }
      if (command.action === "evidence.negative.record") {
        if (command.action_level !== 2) throw new JarvisError("APPROVED_ACTION_LEVEL_TOO_LOW");
        const payload = appendSettledNegativeEvidence(this.authority, this.control, command, now, this.clock());
        return { request_id: requestId, action: command.action, state: "completed", result: payload };
      }
      if (command.action === "memory.confirm") {
        if (command.args.operation === "remember") {
          const result = completeMemoryRememberDecision(this.authority, command, now);
          return { request_id: requestId, action: command.action, state: "completed", result };
        }
        confirmMemoryCorrectionCandidate(this.authority, command, now);
        return { request_id: requestId, action: command.action, state: "completed",
          result: { candidate_id: command.target.candidate_id, state: "approved" } };
      }
      if (command.action === "memory.outbox.dispatch") {
        validateControlAction(command, { enforceMinimumLevel: true, levelErrorCode: "APPROVED_ACTION_LEVEL_TOO_LOW" });
        if (command.args.schema_version === 3) {
          if (this.memoryLifecycle === undefined) {
            throw new JarvisError("MEMORY_LIFECYCLE_SERVICE_UNAVAILABLE");
          }
          return executeApprovedMemoryCommand(this.memoryLifecycle, command);
        }
        if (!this.memoryOutbox) throw new JarvisError("MEMORY_OUTBOX_SERVICE_UNAVAILABLE");
        const queued = this.memoryOutbox.enqueue(command);
        await this.memoryOutbox.runOnce(worker, 1);
        const saga = this.memoryOutbox.get(queued.outbox_id) ?? queued;
        const completedAt = this.clock();
        const completed = saga.state === "settled";
        const failed = ["failed", "expired", "conflict"].includes(saga.state);
        const state = completed ? "completed" : failed ? "failed" : "uncertain";
        const failure = completed ? {} : { failure_code: failed
          ? saga.failure_code ?? "MEMORY_OUTBOX_FAILED" : "MEMORY_OUTBOX_RECONCILING" };
        // A slow observation may outlive our lease. The recovery cycle can
        // already have recorded its terminal proof before returning here.
        const recorded = this.control.get(requestId);
        if (recorded?.state === state && (state === "completed" || state === "failed")) {
          return { request_id: requestId, action: command.action, state,
            result: { outbox_id: saga.outbox_id, state: saga.state }, ...failure };
        }
        this.control.settle(requestId, command.fence, {
          state, effect_type: completed ? "memory.outbox.settled" : failed ? "memory.outbox.failed" : "memory.outbox.reconciling",
          payload: { outbox_id: saga.outbox_id, state: saga.state, request_digest: saga.request_digest,
            settlement_receipt_digest: saga.settlement_receipt_digest },
          ...failure,
        }, completedAt);
        return { request_id: requestId, action: command.action, state,
          result: { outbox_id: saga.outbox_id, state: saga.state },
          ...failure };
      }
      if (command.action === "memory.delete" || command.action === "memory.export") {
        validateControlAction(command, { enforceMinimumLevel: true,
          levelErrorCode: "APPROVED_ACTION_LEVEL_TOO_LOW" });
        if (this.memoryLifecycle === undefined) {
          throw new JarvisError("MEMORY_LIFECYCLE_SERVICE_UNAVAILABLE");
        }
        return executeApprovedMemoryCommand(this.memoryLifecycle, command);
      }
      if (command.action === "memory.generation.rollback") {
        if (!this.memoryEffects) throw new JarvisError("MEMORY_EFFECT_SERVICE_UNAVAILABLE");
        const outcome = this.memoryEffects.rollback(command.args);
        const failureCode = outcome.kind === "data" ? "ROLLBACK_REQUIRES_GENERATION_AUTHORITY" : outcome.code;
        this.control.settle(requestId, command.fence, { state: "failed",
          effect_type: "memory.effect.failure", payload: { code: failureCode },
          failure_code: failureCode }, this.clock());
        return { request_id: requestId, action: command.action, state: "failed",
          result: { code: failureCode }, failure_code: failureCode };
      }
      const effect = await this.run(command, now, externalContext, worker);
      const completedAt = this.clock();
      if (externalContext) this.effects.update(requestId, "confirmed", completedAt, effect.payload);
      this.control.settle(requestId, command.fence, { state: "completed", effect_type: effect.effect_type, payload: effect.payload }, completedAt);
      return { request_id: requestId, action: command.action, state: "completed", result: effect.payload };
    } catch (error) {
      if ((command.action === "memory.outbox.dispatch" && command.args.schema_version === 3)
        || command.action === "memory.delete" || command.action === "memory.export") {
        const code = error instanceof JarvisError ? error.code : "MEMORY_LIFECYCLE_RECONCILING";
        return { request_id: requestId, action: command.action, state: "uncertain",
          result: { code }, failure_code: code };
      }
      const externalUncertain = externalContext !== undefined;
      const code = externalUncertain ? "EXTERNAL_EFFECT_UNCERTAIN" : error instanceof JarvisError ? error.code : "APPROVED_COMMAND_FAILED";
      const payload = { error: error instanceof Error ? error.message : "unknown" };
      const state = isUncertainRunbookError(command, code)
        || (command.action === "state.project" && code === "STATE_PROJECTION_OUTCOME_UNCERTAIN") ? "uncertain" : "failed";
      const completedAt = this.clock();
      if (externalContext) this.effects.update(requestId, "uncertain", completedAt,
        undefined, "EXTERNAL_EFFECT_UNCERTAIN");
      this.control.settle(requestId, command.fence, {
        state, effect_type: state === "uncertain" ? "command.uncertain" : "command.failure",
        payload, failure_code: code,
      }, completedAt);
      return { request_id: requestId, action: command.action, state, result: payload, failure_code: code };
    }
  }
}
