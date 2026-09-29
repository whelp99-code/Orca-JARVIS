import { ApprovedCommandExecutor } from "./approved-executor.js";
import { JarvisError } from "./db.js";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { integer, jsonFile, typedObject } from "./cli-command-input.js";
import {
  ControlPlane,
  type CommandApprovalReceipt,
  type ControlCancelInput,
  type ControlCommandRequestInput,
} from "./control-plane.js";
import { TaskTimeline } from "./task-timeline.js";
import { stageTaskExecution, type StageTaskExecutionInput } from "./task-execution-staging.js";
import { inspectTaskExecutionRepository } from "./task-execution-workspace.js";
import { assertTaskExecutionBinding } from "./task-execution-staging.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { bindMemoryCandidateSpools, createProductionMemoryOutbox } from "./memory-outbox-production.js";
import { executeMemoryIntake } from "./cli-memory-intake.js";
import { executeMemoryReference } from "./cli-memory-reference.js";
import { executeMemoryPostcompact } from "./cli-gjc-commands.js";
import { executeMemoryScopedReconcile } from "./cli-memory-scoped-reconcile.js";
import {
  executeMemoryWithdrawalList, executeMemoryWithdrawalPrepare,
} from "./cli-memory-withdrawal.js";
import { stageMemoryRememberDispatch } from "./memory-remember-dispatch.js";
import { taskExecutionReadiness } from "./task-execution-runtime.js";
import { pageControlCommands } from "./control-command-page.js";
import { learnProviderTombstonesFromFile } from "./cli-provider-tombstone-replica.js";

export async function executeControlCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, values, db } = context;
  if (command === "memory" && subcommand === "learn-provider-tombstones") return learnProviderTombstonesFromFile(context);
  if (command === "memory" && subcommand === "classify") return executeMemoryIntake(context);
  if (command === "memory" && subcommand === "context") return executeMemoryReference(context);
  if (command === "memory" && subcommand === "postcompact") return executeMemoryPostcompact(context);
  if (command === "memory" && subcommand === "reconcile-scoped") return executeMemoryScopedReconcile(context);
  if (command === "memory" && subcommand === "withdrawals") return executeMemoryWithdrawalList(context);
  if (command === "memory" && subcommand === "withdraw-prepare") return executeMemoryWithdrawalPrepare(context);
  if (command === "memory" && subcommand === "stage-dispatch" && argument) {
    const roots = bindMemoryCandidateSpools(db, context.dependencies.memoryOutboxOptions);
    return { ok: true, command: "memory.stage-dispatch",
      request: stageMemoryRememberDispatch(db, argument, commandNow(context), roots) };
  }
  if (command === "memory" && subcommand === "outbox" && (values.once === true || argument === "list")) {
    const runtime = createProductionMemoryOutbox(db, { ...context.dependencies.memoryOutboxOptions,
      clock: () => commandNow(context) });
    try {
      const limit = values.limit === undefined ? 16 : integer(values.limit);
      if (argument === "list") return { ok: true, command: "memory.outbox.list", items: runtime.service.list({ limit }) };
      const cycle = await runtime.service.runOnce(values.worker ?? "cli-memory-outbox", limit);
      return { ok: cycle.failed === 0 && cycle.cleanup_error === undefined && cycle.control_error === undefined,
        command: "memory.outbox", cycle };
    } finally { await runtime.close(); }
  }
  if (command === "memory" && subcommand === "lifecycle" && values.once === true) {
    const lifecycle = context.dependencies.memoryLifecycle;
    if (lifecycle === undefined) throw new JarvisError("MEMORY_LIFECYCLE_SERVICE_UNAVAILABLE");
    return { ok: true, command: "memory.lifecycle", cycle: await lifecycle.reconcilePending(256) };
  }
  if (command === "control") {
    const control = new ControlPlane(db);
    if (subcommand === "check-task" && argument) {
      const input = typedObject(await jsonFile<StageTaskExecutionInput>(argument));
      const plan = parseTaskExecutionPlan(input.plan);
      assertTaskExecutionBinding(db, plan, commandNow(context));
      const repository = await inspectTaskExecutionRepository(plan);
      assertTaskExecutionBinding(db, plan, commandNow(context));
      const readiness = await taskExecutionReadiness(db, plan, () => commandNow(context));
      assertTaskExecutionBinding(db, plan, commandNow(context));
      return { ok: true, command: "control.check-task", repository, ...readiness };
    }
    if (subcommand === "plan-task" && argument) {
      const input = typedObject(await jsonFile<StageTaskExecutionInput>(argument));
      return { ok: true, command: "control.plan-task", request: stageTaskExecution(db, input, commandNow(context)) };
    }
    if (subcommand === "request" && argument) {
      const input = typedObject(await jsonFile<ControlCommandRequestInput>(argument));
      return { ok: true, command: "control.request", request: control.stage(input) };
    }
    if (subcommand === "decide" && argument) {
      const receipt = typedObject(await jsonFile<CommandApprovalReceipt>(argument));
      if (control.get(receipt.request_id)?.action === "memory.confirm") {
        bindMemoryCandidateSpools(db, context.dependencies.memoryOutboxOptions);
      }
      control.decide(receipt, commandNow(context));
      return { ok: true, command: "control.decide", request_id: receipt.request_id, decision: receipt.decision };
    }
    if (subcommand === "cancel" && argument) {
      const input = typedObject(await jsonFile<ControlCancelInput>(argument));
      control.cancel(input, commandNow(context));
      return { ok: true, command: "control.cancel", request_id: input.request_id };
    }
    if (subcommand === "list") {
      if (values.all && (values.limit !== undefined || values.cursor !== undefined)) throw new JarvisError("VALIDATION_ERROR");
      return { ok: true, command: "control.list", ...(values.all ? { requests: control.list() }
        : pageControlCommands(db, values.limit === undefined ? 100 : integer(values.limit), values.cursor)) };
    }
    if (subcommand === "execute" && argument) {
      const request = control.get(argument);
      const runtime = request?.action === "memory.outbox.dispatch" && request.args.schema_version !== 3
        ? createProductionMemoryOutbox(db, { ...context.dependencies.memoryOutboxOptions, clock: () => commandNow(context) })
        : undefined;
      try {
      const execution = await new ApprovedCommandExecutor(db, undefined, undefined, {},
        () => commandNow(context), runtime?.service, undefined,
        context.dependencies.memoryLifecycle).execute(
        argument,
        values.worker ?? "cli-approved-executor",
        commandNow(context),
      );
      return { ok: true, command: "control.execute", execution };
      } finally { await runtime?.close(); }
    }
  }
  if (command !== "timeline") return undefined;
  const timeline = new TaskTimeline(db);
  if (subcommand === "list") {
    return { ok: true, command: "timeline.list", tasks: timeline.list(values.limit ? integer(values.limit) : 100) };
  }
  if (subcommand === "show" && argument) {
    const events = timeline.timeline(argument, values.limit ? integer(values.limit) : 200);
    return { ok: true, command: "timeline.show", task_id: argument, events };
  }
  if (subcommand === "context" && argument) {
    const result = timeline.context(
      argument,
      values.limit ? integer(values.limit) : 100,
      values.max_bytes ? integer(values.max_bytes) : 128 * 1024,
      commandNow(context),
    );
    return { ok: true, command: "timeline.context", task_id: argument, context: result };
  }
  return undefined;
}
