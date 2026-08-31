import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { validateControlAction } from "./control-actions.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";
import { controlWorkflowAdvanceInput, controlWorkflowRunInput } from "./control-workflow-input.js";
import { writeCurrentState } from "./state-projection.js";
import { LoopGraph, type LoopSpec } from "./loopgraph.js";
import { RunbookEngine, type HostOperations } from "./runbook.js";
import { appendSettledNegativeEvidence } from "./negative-evidence.js";
import { executeApprovedWorkflowStage, type ExecuteWorkflowStageInput } from "./approved-workflow-stage.js";
import type { MemoryOutboxService } from "./memory-outbox.js";
import { copyPinnedRegularFile, privatePath, publishFile, removeSqliteCopy, secureBasename, secureRoot } from "./secure-filesystem.js";

export interface ApprovedExecutionResult {
  request_id: string;
  action: string;
  state: "completed" | "failed" | "uncertain";
  result: unknown;
  failure_code?: string;
}

export class ApprovedCommandExecutor {
  private readonly control: ControlPlane;
  constructor(
    private readonly authority: AuthorityDb,
    private readonly backupRoot = resolve(".jarvis-backups"),
    private readonly stateRoot = resolve("state"),
    private readonly hostOperations: HostOperations = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly memoryOutbox?: MemoryOutboxService,
  ) { this.control = new ControlPlane(authority); }

  private externalEffectContext(command: ClaimedControlCommand): { request_id: string; fence: number; effect_id: string; idempotency_key: string } {
    const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
    const idempotencyKey = digest({ request_id: command.request_id, receipt_id: command.receipt_id, fence: command.fence, action: command.action });
    return {
      request_id: command.request_id, fence: command.fence,
      effect_id: `external-effect:${idempotencyKey.slice(7)}`, idempotency_key: idempotencyKey,
    };
  }

  private prepareExternalEffect(command: ClaimedControlCommand, effectType: string, at: Date): ReturnType<ApprovedCommandExecutor["externalEffectContext"]> {
    const context = this.externalEffectContext(command);
    this.authority.db.prepare(
      `INSERT INTO control_effect_attempts(
         attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(`attempt:${context.idempotency_key.slice(7)}`, command.request_id, command.receipt_id,
      command.fence, effectType, context.idempotency_key, "prepared", at.toISOString(), at.toISOString());
    return context;
  }

  private updateExternalEffect(requestId: string, state: "invoking" | "confirmed" | "uncertain", at: Date, receipt?: unknown, errorCode?: string): void {
    const receiptJson = receipt === undefined ? null : canonicalize(receipt);
    const receiptDigest = receiptJson === null ? null : `sha256:${createHash("sha256").update(receiptJson).digest("hex")}`;
    const changed = this.authority.db.prepare(
      `UPDATE control_effect_attempts
       SET state=?,receipt_json=?,receipt_digest=?,error_code=?,updated_at=? WHERE request_id=?`,
    ).run(state, receiptJson, receiptDigest, errorCode ?? null, at.toISOString(), requestId);
    if (changed.changes !== 1) throw new JarvisError("EXTERNAL_EFFECT_ATTEMPT_MISSING");
  }

  private async run(
    command: ClaimedControlCommand,
    now: Date,
    externalContext: ReturnType<ApprovedCommandExecutor["externalEffectContext"]> | undefined,
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

  private uncertainOnError(command: ClaimedControlCommand, code: string): boolean {
    return command.action === "runbook.execute"
      && command.args.runbook_id === "daemon-dead"
      && command.action_level >= 3
      && !new Set([
        "RUNBOOK_INPUT_INVALID", "RUNBOOK_ACTION_LEVEL_TOO_LOW", "RUNBOOK_NOT_FOUND",
      ]).has(code);
  }

  executeWorkflowStage(input: ExecuteWorkflowStageInput): Promise<ApprovedExecutionResult> {
    return executeApprovedWorkflowStage({ authority: this.authority, control: this.control, input });
  }

  async execute(requestId: string, worker = "approved-command-executor", now = this.clock()): Promise<ApprovedExecutionResult> {
    const command = this.control.claim(requestId, worker, now);
    const externalRunbook = command.action === "runbook.execute"
      && command.args.runbook_id === "daemon-dead"
      && command.action_level >= 3
      && Boolean(this.hostOperations.restartService);
    let externalContext: ReturnType<ApprovedCommandExecutor["externalEffectContext"]> | undefined;
    try {
      if (externalRunbook) {
        externalContext = this.prepareExternalEffect(command, "service.restart", now);
        this.updateExternalEffect(requestId, "invoking", now);
      }
      if (command.action === "evidence.negative.record") {
        if (command.action_level !== 2) throw new JarvisError("APPROVED_ACTION_LEVEL_TOO_LOW");
        const payload = appendSettledNegativeEvidence(this.authority, this.control, command, now, this.clock());
        return { request_id: requestId, action: command.action, state: "completed", result: payload };
      }
      if (command.action === "memory.outbox.dispatch") {
        validateControlAction(command, { enforceMinimumLevel: true, levelErrorCode: "APPROVED_ACTION_LEVEL_TOO_LOW" });
        if (!this.memoryOutbox) throw new JarvisError("MEMORY_OUTBOX_SERVICE_UNAVAILABLE");
        const queued = this.memoryOutbox.enqueue(command);
        await this.memoryOutbox.runOnce(worker, 1);
        const saga = this.memoryOutbox.get(queued.outbox_id) ?? queued;
        const completedAt = this.clock();
        const completed = saga.state === "settled";
        this.control.settle(requestId, command.fence, {
          state: completed ? "completed" : "uncertain",
          effect_type: completed ? "memory.outbox.settled" : "memory.outbox.reconciling",
          payload: { outbox_id: saga.outbox_id, state: saga.state, request_digest: saga.request_digest,
            settlement_receipt_digest: saga.settlement_receipt_digest },
          ...(completed ? {} : { failure_code: "MEMORY_OUTBOX_RECONCILING" }),
        }, completedAt);
        return { request_id: requestId, action: command.action, state: completed ? "completed" : "uncertain",
          result: { outbox_id: saga.outbox_id, state: saga.state },
          ...(completed ? {} : { failure_code: "MEMORY_OUTBOX_RECONCILING" }) };
      }
      const effect = await this.run(command, now, externalContext, worker);
      const completedAt = this.clock();
      if (externalContext) this.updateExternalEffect(requestId, "confirmed", completedAt, effect.payload);
      this.control.settle(requestId, command.fence, { state: "completed", effect_type: effect.effect_type, payload: effect.payload }, completedAt);
      return { request_id: requestId, action: command.action, state: "completed", result: effect.payload };
    } catch (error) {
      const externalUncertain = externalContext !== undefined;
      const code = externalUncertain ? "EXTERNAL_EFFECT_UNCERTAIN" : error instanceof JarvisError ? error.code : "APPROVED_COMMAND_FAILED";
      const payload = { error: error instanceof Error ? error.message : "unknown" };
      const state = this.uncertainOnError(command, code) ? "uncertain" : "failed";
      const completedAt = this.clock();
      if (externalContext) this.updateExternalEffect(requestId, "uncertain", completedAt, undefined, "EXTERNAL_EFFECT_UNCERTAIN");
      this.control.settle(requestId, command.fence, {
        state, effect_type: state === "uncertain" ? "command.uncertain" : "command.failure",
        payload, failure_code: code,
      }, completedAt);
      return { request_id: requestId, action: command.action, state, result: payload, failure_code: code };
    }
  }
}
